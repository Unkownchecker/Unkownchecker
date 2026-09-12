// ---- Local network discovery ----
// Browsers can't do real mDNS/Bonjour lookups from a web page, so "auto-
// discover" here means: try the address that worked last time, and if that
// fails, probe the local /24 subnet for something answering on the LAN
// Print port. Works well on typical flat home/office Wi-Fi; won't find the
// server across VLANs, guest networks with client isolation, or unusually
// large subnets.

const PORT = 3000;
const LOCAL_IP_KEY = "lanprint_server_ip";
const MODE_KEY = "lanprint_mode"; // 'local' | 'remote'
const RELAY_URL_KEY = "lanprint_relay_url";
const RELAY_ID_KEY = "lanprint_relay_id";

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function pingLocal(ip) {
  const base = `http://${ip}:${PORT}`;
  const res = await withTimeout(fetch(base + "/api/ping", { cache: "no-store" }), 1200);
  if (!res.ok) throw new Error("bad response");
  const data = await res.json();
  if (!data.ok) throw new Error("not a LAN Print server");
  return base;
}

function getOwnLocalIP() {
  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("");
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const match = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(e.candidate.candidate);
        if (match) { resolve(match[1]); pc.close(); }
      };
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => resolve(null), 1500);
    } catch { resolve(null); }
  });
}

async function scanSubnet(onProgress) {
  const myIp = await getOwnLocalIP();
  if (!myIp) return null;
  const prefix = myIp.split(".").slice(0, 3).join(".");
  const candidates = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);

  const concurrency = 40;
  let index = 0, found = null, scanned = 0;

  async function worker() {
    while (index < candidates.length && !found) {
      const ip = candidates[index++];
      try { found = await pingLocal(ip); } catch { /* not it */ }
      scanned++;
      onProgress && onProgress(scanned, candidates.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

async function discoverLocalServer(onStatus) {
  const params = new URLSearchParams(location.search);
  const fromQr = params.get("ip");
  if (fromQr) {
    try {
      const base = await pingLocal(fromQr);
      localStorage.setItem(LOCAL_IP_KEY, fromQr);
      history.replaceState({}, "", location.pathname);
      return base;
    } catch { /* fall through */ }
  }

  const remembered = localStorage.getItem(LOCAL_IP_KEY);
  if (remembered) {
    try {
      onStatus && onStatus("Checking last known printer…");
      return await pingLocal(remembered);
    } catch { /* fall through */ }
  }

  onStatus && onStatus("Searching your network for the printer…");
  const found = await scanSubnet((done, total) => {
    onStatus && onStatus(`Searching your network for the printer… (${done}/${total})`);
  });
  if (found) {
    localStorage.setItem(LOCAL_IP_KEY, new URL(found).hostname);
    return found;
  }
  return null;
}

// ---- Remote (anywhere) mode, via relay + pairing ID ----
async function checkRemote(relayUrl, id) {
  const url = relayUrl.replace(/\/+$/, "");
  const res = await withTimeout(fetch(`${url}/relay/${id}/status`, { cache: "no-store" }), 60000);
  const data = await res.json();
  if (!data.online) throw new Error("Printer is offline (or the relay is waking up — try again in a few seconds)");
  return url;
}

// ---- App wiring ----
document.addEventListener("DOMContentLoaded", () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  const connEl = document.getElementById("connection");
  const connStatus = document.getElementById("connStatus");
  const spinner = document.querySelector("#connection .spinner");
  const manualForm = document.getElementById("manualForm");
  const manualInput = document.getElementById("manualIp");
  const rescanBtn = document.getElementById("rescanBtn");
  const changeServerLink = document.getElementById("changeServer");
  const printSection = document.getElementById("printSection");
  const tabLocal = document.getElementById("tabLocal");
  const tabRemote = document.getElementById("tabRemote");
  const remoteForm = document.getElementById("remoteForm");
  const relayUrlInput = document.getElementById("relayUrlField");
  const relayIdInput = document.getElementById("relayIdField");

  let mode = localStorage.getItem(MODE_KEY) || "local";

  // Pages loaded over HTTPS (i.e., opened via the relay's URL) can't fetch a
  // plain-HTTP local printer PC — browsers block that as mixed content. When
  // that's the case, this is really only useful in Anywhere mode, so hide
  // the local tab entirely rather than offering a button that can't work.
  const isSecurePage = location.protocol === "https:";
  if (isSecurePage) {
    tabLocal.classList.add("hidden");
    mode = "remote";
  }

  function showConnecting(msg) {
    connEl.classList.remove("hidden");
    printSection.classList.add("hidden");
    manualForm.classList.add("hidden");
    remoteForm.classList.add("hidden");
    if (spinner) spinner.classList.remove("hidden");
    connStatus.textContent = msg;
    rescanBtn.classList.add("hidden");
  }

  function setTabs() {
    tabLocal.classList.toggle("active", mode === "local");
    tabRemote.classList.toggle("active", mode === "remote");
  }

  async function connectLocal() {
    setTabs();
    showConnecting("Looking for your printer…");
    const base = await discoverLocalServer((msg) => (connStatus.textContent = msg));
    if (base) {
      connEl.classList.add("hidden");
      printSection.classList.remove("hidden");
      window.initPrintForm({ printers: base + "/api/printers", print: base + "/api/print" });
    } else {
      if (spinner) spinner.classList.add("hidden");
      connStatus.textContent = "Couldn't find it automatically.";
      manualForm.classList.remove("hidden");
      rescanBtn.classList.remove("hidden");
    }
  }

  async function connectRemote(relayUrl, id) {
    setTabs();
    showConnecting("Connecting to your printer…");
    try {
      const base = await checkRemote(relayUrl, id);
      localStorage.setItem(RELAY_URL_KEY, relayUrl);
      localStorage.setItem(RELAY_ID_KEY, id);
      connEl.classList.add("hidden");
      printSection.classList.remove("hidden");
      window.initPrintForm({ printers: `${base}/relay/${id}/printers`, print: `${base}/relay/${id}/print` }, { remote: true });
    } catch (err) {
      if (spinner) spinner.classList.add("hidden");
      connStatus.textContent = err.message || "Couldn't connect.";
      remoteForm.classList.remove("hidden");
      rescanBtn.classList.remove("hidden");
    }
  }

  function startMode(newMode) {
    mode = newMode;
    localStorage.setItem(MODE_KEY, mode);
    if (mode === "local") {
      connectLocal();
    } else {
      const savedUrl = localStorage.getItem(RELAY_URL_KEY);
      const savedId = localStorage.getItem(RELAY_ID_KEY);
      if (savedUrl && savedId) {
        connectRemote(savedUrl, savedId);
      } else {
        setTabs();
        if (spinner) spinner.classList.add("hidden");
        connEl.classList.remove("hidden");
        printSection.classList.add("hidden");
        connStatus.textContent = "Enter your relay address and pairing ID";
        remoteForm.classList.remove("hidden");
        rescanBtn.classList.add("hidden");
      }
    }
  }

  tabLocal.addEventListener("click", () => startMode("local"));
  tabRemote.addEventListener("click", () => startMode("remote"));

  manualForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ip = manualInput.value.trim();
    if (!ip) return;
    connStatus.textContent = "Connecting…";
    try {
      const base = await pingLocal(ip);
      localStorage.setItem(LOCAL_IP_KEY, ip);
      connEl.classList.add("hidden");
      printSection.classList.remove("hidden");
      window.initPrintForm({ printers: base + "/api/printers", print: base + "/api/print" });
    } catch {
      connStatus.textContent = "Couldn't reach that address. Check it and try again.";
    }
  });

  remoteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = relayUrlInput.value.trim();
    const id = relayIdInput.value.trim().toUpperCase();
    if (!url || !id) return;
    connectRemote(url, id);
  });

  rescanBtn.addEventListener("click", () => startMode(mode));
  changeServerLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (mode === "local") localStorage.removeItem(LOCAL_IP_KEY);
    else { localStorage.removeItem(RELAY_URL_KEY); localStorage.removeItem(RELAY_ID_KEY); }
    startMode(mode);
  });

  // Prefill remote form with anything remembered, for convenience when re-editing.
  const savedUrl = localStorage.getItem(RELAY_URL_KEY);
  const savedId = localStorage.getItem(RELAY_ID_KEY);
  if (savedUrl) relayUrlInput.value = savedUrl;
  if (savedId) relayIdInput.value = savedId;

  startMode(mode);
});
