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

// deviceId -> { ws, lastSeen, binarySupported }
const devices = new Map();
// requestId -> { resolve, reject, timer, ws, deviceId }
const pending = new Map();

// deviceId -> { activeJobs, recentJobs: [], totalJobsCompleted, totalJobsFailed }
const deviceTelemetry = new Map();
const MAX_RECENT_JOBS = 50;

function getDeviceTelemetry(deviceId) {
  let stats = deviceTelemetry.get(deviceId);
  if (!stats) {
    stats = {
      activeJobs: 0,
      recentJobs: [],
      totalJobsCompleted: 0,
      totalJobsFailed: 0,
    };
    deviceTelemetry.set(deviceId, stats);
  }
  return stats;
}

function calculateLatencyMetrics(recentJobs) {
  const validLatencies = (recentJobs || [])
    .map((j) => (j && typeof j.latencyMs === "number" ? j.latencyMs : null))
    .filter((l) => typeof l === "number" && !isNaN(l) && l >= 0);

  if (validLatencies.length === 0) {
    return { avgLatencyMs: 0, p95LatencyMs: 0 };
  }

  const sum = validLatencies.reduce((acc, val) => acc + val, 0);
  const avgLatencyMs = Math.round((sum / validLatencies.length) * 100) / 100;

  const sorted = [...validLatencies].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1;
  const p95Index = Math.max(0, Math.min(rank, sorted.length - 1));
  const p95LatencyMs = Math.round(sorted[p95Index] * 100) / 100;

  return { avgLatencyMs, p95LatencyMs };
}

/**
 * Atomic Length-Prefixed Binary WebSocket Framing
 * Format: [4-byte UInt32BE headerLen] [UTF-8 JSON headerBytes] [Raw binary payload bytes]
 */
function packBinaryMessage(meta, payloadBuffer) {
  const metaBuf = Buffer.from(JSON.stringify(meta), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(metaBuf.length, 0);
  const payload = payloadBuffer || Buffer.alloc(0);
  return Buffer.concat([header, metaBuf, payload]);
}

function unpackBinaryMessage(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const headerLen = buffer.readUInt32BE(0);
  if (headerLen <= 0 || 4 + headerLen > buffer.length) return null;
  try {
    const meta = JSON.parse(buffer.slice(4, 4 + headerLen).toString("utf8"));
    const payload = buffer.slice(4 + headerLen);
    return { meta, payload };
  } catch {
    return null;
  }
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function rpc(deviceId, message, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const device = devices.get(deviceId);
    if (!device) return reject(Object.assign(new Error("offline"), { ok: false, error: "device_offline" }));

    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(new Error("timeout"), { ok: false, error: "timeout" }));
    }, timeoutMs);

    // Track the socket associated with each pending RPC
    pending.set(requestId, { resolve, reject, timer, ws: device.ws, deviceId });

    if (device.binarySupported && message.binaryPayload) {
      const { binaryPayload, ...meta } = message;
      meta.requestId = requestId;
      const frame = packBinaryMessage(meta, binaryPayload);
      try {
        if (device.ws.readyState !== WebSocket.OPEN) {
          clearTimeout(timer);
          pending.delete(requestId);
          return reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
        }
        device.ws.send(frame, { binary: true }, (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
          }
        });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
      }
    } else {
      let sendObj = { ...message, requestId };
      if (sendObj.binaryPayload) {
        if (!sendObj.fileBase64) {
          sendObj.fileBase64 = sendObj.binaryPayload.toString("base64");
        }
        delete sendObj.binaryPayload;
      }
      try {
        if (device.ws.readyState !== WebSocket.OPEN) {
          clearTimeout(timer);
          pending.delete(requestId);
          return reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
        }
        device.ws.send(JSON.stringify(sendObj), (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
          }
        });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
      }
    }
  });
}

app.get("/health", (req, res) => res.json({ ok: true, server: "test-server", time: Date.now() }));
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

app.get("/relay/:id/telemetry", (req, res) => {
  const deviceId = req.params.id;
  const device = devices.get(deviceId);
  const stats = getDeviceTelemetry(deviceId);
  const { avgLatencyMs, p95LatencyMs } = calculateLatencyMetrics(stats.recentJobs);

  res.json({
    deviceId,
    online: !!device,
    activeJobs: stats.activeJobs,
    avgLatencyMs,
    p95LatencyMs,
    recentJobs: stats.recentJobs,
    totalJobsCompleted: stats.totalJobsCompleted,
    totalJobsFailed: stats.totalJobsFailed,
  });
});

app.post("/relay/:id/print", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!devices.has(req.params.id)) return res.status(404).json({ error: "offline" });

  const deviceId = req.params.id;
  const stats = getDeviceTelemetry(deviceId);
  stats.activeJobs++;
  const jobStartTime = performance.now();
  const generatedJobId = `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  let fileBuffer = req.file.buffer;
  let filename = req.file.originalname;

  try {
    const isFirmware =
      req.body.isFirmware === true ||
      req.body.isFirmware === "true" ||
      /\.(img|dl)$/i.test(filename);

    const isPdf =
      filename.toLowerCase().endsWith(".pdf") ||
      (fileBuffer.length > 4 && fileBuffer.slice(0, 5).toString("latin1").startsWith("%PDF-"));

    const isPreformatted =
      req.body.isPreformatted === true || req.body.isPreformatted === "true";

    // Fast-path: PDFs and preformatted documents bypass slow server-side pdf-lib recompilation completely.
    // Android's native PdfRenderer renders PDF directly in hardware.
    // Only raw non-PDF image uploads (PNG, JPG) need conversion.
    if (!isFirmware && !isPdf && !isPreformatted) {
      const prepared = await prepareDocumentForPrinter(fileBuffer, filename, {
        orientation: req.body.orientation,
        paperSize: req.body.paperSize,
      });
      if (prepared && prepared.buffer) {
        fileBuffer = prepared.buffer;
        filename = prepared.filename || filename;
      }
    }

    // Orientation Preservation in PDF Fast-Path:
    // If isPdf === true or req.body.isPreformatted === "true", forward orientation: req.body.orientation || "auto".
    // Only default to "portrait" if non-PDF images were pre-oriented by prepareDocumentForPrinter.
    const orientation = (isPdf || isPreformatted)
      ? (req.body.orientation || "auto")
      : "portrait";

    const result = await rpc(
      deviceId,
      {
        type: "print",
        filename: filename,
        binaryPayload: fileBuffer,
        options: {
          printer: req.body.printer,
          copies: req.body.copies,
          orientation: orientation,
          paperSize: req.body.paperSize || "a4",
          side: req.body.side,
          scale: req.body.scale,
          pages: req.body.pages,
          monochrome: req.body.monochrome,
          isPreformatted: isPreformatted,
        },
      },
      90000
    );

    const serverLatencyMs = Math.round((performance.now() - jobStartTime) * 100) / 100;
    const clientTelemetry = (result && typeof result === "object" && result.telemetry) ? result.telemetry : {};

    const stages = {
      serverLatencyMs,
      rasterMs: Number(clientTelemetry.rasterMs) || 0,
      ditherMs: Number(clientTelemetry.ditherMs) || 0,
      encodeMs: Number(clientTelemetry.encodeMs) || 0,
      usbMs: Number(clientTelemetry.usbMs) || 0,
      clientTotalMs: Number(clientTelemetry.totalMs) || 0,
    };

    const finalJobId = (result && result.jobId) || generatedJobId;
    const isSuccess = Boolean(result && result.ok);

    const jobRecord = {
      jobId: finalJobId,
      timestamp: Date.now(),
      filename: filename,
      printer: req.body.printer || "default",
      status: isSuccess ? "success" : "failed",
      fileSizeBytes: req.file ? req.file.size : fileBuffer.length,
      latencyMs: serverLatencyMs,
      stages,
      error: isSuccess ? null : ((result && result.error) || "Print failed"),
    };

    stats.recentJobs.unshift(jobRecord);
    if (stats.recentJobs.length > MAX_RECENT_JOBS) {
      stats.recentJobs.pop();
    }

    if (isSuccess) {
      stats.totalJobsCompleted++;
    } else {
      stats.totalJobsFailed++;
    }

    if (!result.ok) {
      return res.status(500).json({ error: result.error || "Print failed" });
    }

    result.jobId = finalJobId;
    result.telemetry = {
      jobId: finalJobId,
      latencyMs: serverLatencyMs,
      ...stages,
    };

    res.json(result);
  } catch (err) {
    const serverLatencyMs = Math.round((performance.now() - jobStartTime) * 100) / 100;
    const isOffline = err.message === "offline" || err.message === "device_offline" || err.error === "device_offline";
    const status = isOffline ? 404 : 504;
    const errorMsg = err.message === "timeout" ? "Printer didn't respond in time" : (err.message || err.error || "offline");

    const jobRecord = {
      jobId: generatedJobId,
      timestamp: Date.now(),
      filename: filename,
      printer: req.body.printer || "default",
      status: "failed",
      fileSizeBytes: req.file ? req.file.size : fileBuffer.length,
      latencyMs: serverLatencyMs,
      stages: {
        serverLatencyMs,
        rasterMs: 0,
        ditherMs: 0,
        encodeMs: 0,
        usbMs: 0,
        clientTotalMs: 0,
      },
      error: errorMsg,
    };

    stats.recentJobs.unshift(jobRecord);
    if (stats.recentJobs.length > MAX_RECENT_JOBS) {
      stats.recentJobs.pop();
    }
    stats.totalJobsFailed++;

    res.status(status).json({ error: errorMsg });
  } finally {
    stats.activeJobs = Math.max(0, stats.activeJobs - 1);
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
        binaryPayload: req.file.buffer,
      },
      30000
    );
    res.json(result);
  } catch (err) {
    const isOffline = err.message === "offline" || err.message === "device_offline" || err.error === "device_offline";
    const status = isOffline ? 404 : 504;
    const errorMsg = err.message === "timeout" ? "Printer didn't respond in time" : (err.message || err.error || "offline");
    res.status(status).json({ error: errorMsg });
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

wss.on("connection", (ws, req) => {
  let registeredId = null;
  ws.missedPings = 0;
  ws.on("pong", () => { ws.missedPings = 0; });

  let queryBinary = false;
  try {
    const urlObj = new URL(req.url, "http://localhost");
    const caps = urlObj.searchParams.get("capabilities") || "";
    if (caps.split(",").includes("binary") || urlObj.searchParams.get("binary") === "true") {
      queryBinary = true;
    }
  } catch {}

  ws.on("message", (raw, isBinary) => {
    let msg;
    if (isBinary || (Buffer.isBuffer(raw) && raw.length >= 4 && raw[0] !== 0x7b /* '{' */)) {
      const unpacked = unpackBinaryMessage(raw);
      if (unpacked) msg = unpacked.meta;
    }
    if (!msg) {
      try { msg = JSON.parse(raw.toString()); } catch { return; }
    }

    if (msg.type === "register" && msg.id) {
      registeredId = msg.id;
      // If there was an existing connection for this ID, close it cleanly
      const existing = devices.get(registeredId);
      if (existing && existing.ws !== ws) {
        try { existing.ws.terminate(); } catch {}
      }
      const binarySupported = Boolean(
        queryBinary ||
        msg.binarySupported === true ||
        (Array.isArray(msg.capabilities) && (msg.capabilities.includes("binary") || msg.capabilities.includes("binary_frames")))
      );
      devices.set(registeredId, { ws, lastSeen: Date.now(), binarySupported });
      send(ws, { type: "registered", id: registeredId, binarySupported });
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
    // Track socket associated with each pending RPC.
    // On ws.on("close"), immediately reject all pending RPC requests for that disconnected socket
    // with { ok: false, error: "device_offline" } so HTTP POST callers fail immediately instead of hanging for 90 seconds.
    for (const [reqId, p] of pending.entries()) {
      if (p.ws === ws) {
        clearTimeout(p.timer);
        pending.delete(reqId);
        p.reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
      }
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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`LAN Print relay listening on port ${PORT}`);
  });
}

module.exports = {
  app,
  server,
  wss,
  devices,
  pending,
  rpc,
  packBinaryMessage,
  unpackBinaryMessage,
  deviceTelemetry,
  getDeviceTelemetry,
  calculateLatencyMetrics,
  MAX_RECENT_JOBS,
};
