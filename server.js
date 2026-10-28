// LAN Print Relay
//
// Sits on the internet so a phone (on any network) can send a print job to a
// desktop PC (on any other network) without either side needing port
// forwarding. The desktop makes an outbound WebSocket connection here and
// registers under a short pairing ID; phones hit plain HTTPS endpoints named
// with that ID, and this relay forwards the request/response over that
// WebSocket.
//
// This is intentionally simple: no accounts, no database. The pairing ID
// itself is the shared secret — anyone who has it can send print jobs to
// that desktop while it's online. Treat it like a PIN: don't post it publicly.

const express = require("express");
const multer = require("multer");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { prepareDocumentForPrinter } = require("./prepare-pdf");

const PORT = process.env.PORT || 10000;
const MAX_FILE_MB = 20;
const RPC_TIMEOUT_MS = 20000;

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());

// In-memory rate limiter for relay status and RPC endpoints to prevent brute-forcing pairing IDs
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  let record = requestCounts.get(ip);
  if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    record = { startTime: now, count: 0 };
    requestCounts.set(ip, record);
  }
  record.count++;
  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({ error: "Too many requests, please slow down." });
  }
  next();
}

app.use("/relay", rateLimiter);

// Cleanup expired rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of requestCounts.entries()) {
    if (now - record.startTime > RATE_LIMIT_WINDOW_MS) {
      requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Serve the same app shell used locally, so this relay's own URL is
// something you can add to a phone's home screen and have it always open
// (it's HTTPS, so — unlike the local printer PC — it works as a real
// installed app away from any particular network).
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

// deviceId -> { ws, lastSeen }
const devices = new Map();
// requestId -> { resolve, reject, timer }
const pending = new Map();

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function rpc(deviceId, message, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const device = devices.get(deviceId);
    if (!device) return reject(new Error("offline"));

    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("timeout"));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    send(device.ws, { ...message, requestId });
  });
}

app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));
app.get("/firmware", (req, res) => res.redirect("/firmware/"));

app.get("/relay/:id/status", (req, res) => {
  const device = devices.get(req.params.id);
  res.json({ online: !!device });
});

app.get("/relay/:id/printers", async (req, res) => {
  try {
    const result = await rpc(req.params.id, { type: "get_printers" });
    if (result.error) return res.status(500).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(err.message === "offline" ? 404 : 504).json({ error: err.message });
  }
});

app.post("/relay/:id/print", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!devices.has(req.params.id)) return res.status(404).json({ error: "offline" });

  try {
    let fileBuffer = req.file.buffer;
    let filename = req.file.originalname;

    const isFirmware =
      req.body.isFirmware === true ||
      req.body.isFirmware === "true" ||
      /\.(img|dl)$/i.test(filename);

    if (!isFirmware) {
      const prepared = await prepareDocumentForPrinter(fileBuffer, filename, {
        orientation: req.body.orientation,
        paperSize: req.body.paperSize,
      });
      if (prepared && prepared.buffer) {
        fileBuffer = prepared.buffer;
        filename = prepared.filename || filename;
      }
    }

    const result = await rpc(
      req.params.id,
      {
        type: "print",
        filename: filename,
        fileBase64: fileBuffer.toString("base64"),
        options: {
          printer: req.body.printer,
          copies: req.body.copies,
          // Always send 'portrait' to Android host because the document has already
          // been pre-oriented and sized to [1190.35, 841.89] (the exact 1200x600 drum geometry).
          // Sending 'portrait' ensures the Android APK rasterizer preserves targetW=9920, targetH=7016
          // matching -g9920x7016 without squashing or orientation mismatch.
          orientation: "portrait",
          paperSize: req.body.paperSize || "a4",
          side: req.body.side,
          scale: req.body.scale,
          pages: req.body.pages,
          monochrome: req.body.monochrome,
        },
      },
      30000
    );
    if (!result.ok) return res.status(500).json({ error: result.error || "Print failed" });
    res.json(result);
  } catch (err) {
    res.status(err.message === "offline" ? 404 : 504).json({ error: err.message === "timeout" ? "Printer didn't respond in time" : err.message });
  }
});

app.post("/relay/:id/firmware", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!devices.has(req.params.id)) return res.status(404).json({ error: "offline" });

  try {
    const result = await rpc(
      req.params.id,
      {
        type: "upload_firmware",
        filename: req.file.originalname,
        fileBase64: req.file.buffer.toString("base64"),
      },
      30000
    );
    res.json(result);
  } catch (err) {
    res.status(err.message === "offline" ? 404 : 504).json({ error: err.message === "timeout" ? "Printer didn't respond in time" : err.message });
  }
});

// Manual duplex, phase 2: printed after whoever's at the printer flips the stack.
app.post("/relay/:id/print-manual/:jobId/continue", async (req, res) => {
  try {
    const result = await rpc(req.params.id, {
      type: "continue_manual",
      jobId: req.params.jobId,
      reverseEven: req.body.reverseEven,
    });
    if (!result.ok) return res.status(400).json({ error: result.error || "Print failed" });
    res.json(result);
  } catch (err) {
    res.status(err.message === "offline" ? 404 : 504).json({ error: err.message === "timeout" ? "Printer didn't respond in time" : err.message });
  }
});

app.post("/relay/:id/print-manual/:jobId/cancel", async (req, res) => {
  try {
    const result = await rpc(req.params.id, { type: "cancel_manual", jobId: req.params.jobId });
    res.json(result);
  } catch (err) {
    res.status(err.message === "offline" ? 404 : 504).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 35 * 1024 * 1024, // 35MB max to allow base64 file payloads for ~20MB documents
});

wss.on("connection", (ws) => {
  let registeredId = null;
  ws.missedPings = 0;
  ws.on("pong", () => { ws.missedPings = 0; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "register" && msg.id) {
      registeredId = msg.id;
      // If there was an existing connection for this ID, close it cleanly
      const existing = devices.get(registeredId);
      if (existing && existing.ws !== ws) {
        try { existing.ws.terminate(); } catch {}
      }
      devices.set(registeredId, { ws, lastSeen: Date.now() });
      send(ws, { type: "registered", id: registeredId });
      return;
    }

    if (msg.type === "app_ping") {
      ws.missedPings = 0;
      send(ws, { type: "app_pong" });
      return;
    }

    if (msg.type && msg.type.endsWith("_result")) {
      const p = pending.get(msg.requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.requestId);
        p.resolve(msg);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (registeredId && devices.get(registeredId)?.ws === ws) {
      devices.delete(registeredId);
    }
  });
});

// Proxies and idle connections can die without a clean close frame. Ping
// every connected client periodically. Allow 2 missed intervals (40-60s) before
// terminating to accommodate mobile network jitter.
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.missedPings >= 2) {
      return ws.terminate();
    }
    ws.missedPings = (ws.missedPings || 0) + 1;
    try { ws.ping(); } catch {}
  });
}, 20000);

wss.on("close", () => clearInterval(heartbeatInterval));

// Keep Render free instance awake 24/7 by pinging /health every 10 minutes (Render sleeps at 15m)
const RENDER_PING_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || "https://printer-p35v.onrender.com";
  try {
    const httpLib = url.startsWith("https") ? require("https") : require("http");
    httpLib.get(`${url}/health`, () => {}).on("error", () => {});
  } catch {}
}, RENDER_PING_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`LAN Print relay listening on port ${PORT}`);
});
