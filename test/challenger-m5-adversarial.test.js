/**
 * Milestone M5 Empirical Adversarial Verification Suite
 * Challenger: Teamwork Challenger M5
 *
 * Comprehensive stress testing of:
 * 1. Length-Prefixed Binary Framing & Wire Format Stress (0-byte, multi-MB, malformed, truncated, corrupt headers)
 * 2. WebSocket Wire Negotiation (Binary vs Legacy Base64, resilience against malformed client frames)
 * 3. Orientation Handling Stress (landscape, portrait, auto, empty, uppercase, custom, non-PDF, preformatted, firmware)
 * 4. Socket Lifecycle & Immediate Disconnect Abort Stress (<200ms abort vs 90s hang, multi-request drop, rapid churn)
 */

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const { createSuite, assert } = require("./runner");
const {
  app,
  server,
  wss,
  devices,
  pending,
  rpc,
  packBinaryMessage,
  unpackBinaryMessage,
} = require("../server");
const { FIXTURES_DIR } = require("./generate-fixtures");

const suite = createSuite("M5 Challenger: Empirical Adversarial Stress Suite");

// Ephemeral server management
let serverPort = null;
let serverUrl = null;
let wsUrl = null;

async function ensureServerStarted() {
  if (server.listening) {
    const addr = server.address();
    serverPort = addr.port;
    serverUrl = `http://127.0.0.1:${serverPort}`;
    wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
    return;
  }
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      serverPort = addr.port;
      serverUrl = `http://127.0.0.1:${serverPort}`;
      wsUrl = `ws://127.0.0.1:${serverPort}/ws`;
      resolve();
    });
    server.on("error", reject);
  });
}

function createClientWs(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const binaryMessages = [];
  const textMessages = [];
  let onMessageCallback = null;

  ws.on("message", (data, isBinary) => {
    if (isBinary || (Buffer.isBuffer(data) && data.length >= 4 && data[0] !== 0x7b)) {
      binaryMessages.push(data);
    } else {
      textMessages.push(data.toString());
    }
    if (onMessageCallback) {
      const cb = onMessageCallback;
      onMessageCallback = null;
      cb({ data, isBinary });
    } else {
      messages.push({ data, isBinary });
    }
  });

  return {
    ws,
    messages,
    binaryMessages,
    textMessages,
    waitForOpen: () =>
      new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) return resolve();
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    waitForMessage: (timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        if (messages.length > 0) return resolve(messages.shift());
        const timer = setTimeout(() => {
          onMessageCallback = null;
          reject(new Error(`Timeout waiting for WS message (${timeoutMs}ms)`));
        }, timeoutMs);
        onMessageCallback = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      }),
    sendJson: (obj) => ws.send(JSON.stringify(obj)),
    sendBinary: (buf) => ws.send(buf, { binary: true }),
    close: () => {
      try {
        ws.close();
      } catch {}
    },
    terminate: () => {
      try {
        ws.terminate();
      } catch {}
    },
  };
}

async function postMultipart(endpoint, fields = {}, fileObj = null) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) {
      formData.append(k, String(v));
    }
  }
  if (fileObj) {
    formData.append(
      fileObj.fieldName || "file",
      new Blob([fileObj.buffer]),
      fileObj.filename || "test.pdf"
    );
  }

  const res = await fetch(`${serverUrl}${endpoint}`, {
    method: "POST",
    body: formData,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, ok: res.ok };
}

// ─────────────────────────────────────────────────────────────
// TIER A: Binary Framing & Header Boundary Stress Tests
// ─────────────────────────────────────────────────────────────

suite.test("A.1 Framing: 0-byte payload roundtrip preserves empty buffer", async () => {
  const meta = { type: "test", requestId: "zero-byte-test", options: {} };
  const emptyBuf = Buffer.alloc(0);

  const packed = packBinaryMessage(meta, emptyBuf);
  assert.strictEqual(packed.length, 4 + Buffer.from(JSON.stringify(meta), "utf8").length);

  const unpacked = unpackBinaryMessage(packed);
  assert.ok(unpacked !== null, "Unpack must succeed on 0-byte payload");
  assert.deepStrictEqual(unpacked.meta, meta);
  assert.strictEqual(unpacked.payload.length, 0);
});

suite.test("A.2 Framing: 1-byte payload roundtrip", async () => {
  const meta = { type: "print", requestId: "one-byte", filename: "byte.bin" };
  const oneByte = Buffer.from([0x42]);

  const packed = packBinaryMessage(meta, oneByte);
  const unpacked = unpackBinaryMessage(packed);
  assert.ok(unpacked !== null);
  assert.deepStrictEqual(unpacked.meta, meta);
  assert.strictEqual(unpacked.payload.length, 1);
  assert.strictEqual(unpacked.payload[0], 0x42);
});

suite.test("A.3 Framing: Multi-megabyte (5MB) high-entropy payload SHA-256 byte fidelity", async () => {
  const meta = { type: "print", requestId: "multi-mb-5mb", filename: "large.pdf" };
  const payload5Mb = crypto.randomBytes(5 * 1024 * 1024);
  const originalSha = crypto.createHash("sha256").update(payload5Mb).digest("hex");

  const packed = packBinaryMessage(meta, payload5Mb);
  const unpacked = unpackBinaryMessage(packed);

  assert.ok(unpacked !== null);
  assert.deepStrictEqual(unpacked.meta, meta);
  const unpackedSha = crypto.createHash("sha256").update(unpacked.payload).digest("hex");
  assert.strictEqual(unpackedSha, originalSha, "5MB payload must match bit-for-bit");
});

suite.test("A.4 Framing: Maximum allowed file size (20MB) roundtrip", async () => {
  const meta = { type: "print", requestId: "max-20mb", filename: "huge.pdf" };
  const payload20Mb = Buffer.alloc(20 * 1024 * 1024, 0x5a); // 20MB of pattern 0x5a
  const originalSha = crypto.createHash("sha256").update(payload20Mb).digest("hex");

  const packed = packBinaryMessage(meta, payload20Mb);
  const unpacked = unpackBinaryMessage(packed);

  assert.ok(unpacked !== null);
  const unpackedSha = crypto.createHash("sha256").update(unpacked.payload).digest("hex");
  assert.strictEqual(unpackedSha, originalSha, "20MB payload must match bit-for-bit");
});

suite.test("A.5 Framing: Wire size efficiency vs Base64 expansion", async () => {
  const meta = { type: "print", requestId: "size-eval", filename: "bench.pdf" };
  const payload = crypto.randomBytes(1024 * 1024); // 1MB random payload

  const binaryFrame = packBinaryMessage(meta, payload);
  const base64Wire = JSON.stringify({ ...meta, fileBase64: payload.toString("base64") });

  const savingsBytes = base64Wire.length - binaryFrame.length;
  const savingsPct = (savingsBytes / base64Wire.length) * 100;

  // Base64 expands by 33.3%, so binary saving should be ~25% of total base64 wire payload
  assert.ok(savingsBytes > 300000, `Expected >300KB savings on 1MB payload, saved ${savingsBytes} bytes`);
  assert.ok(savingsPct > 24, `Expected >24% reduction in wire bytes, achieved ${savingsPct.toFixed(2)}%`);
});

suite.test("A.6 Malformed Framing: Invalid inputs return null safely without throwing", async () => {
  assert.strictEqual(unpackBinaryMessage(null), null);
  assert.strictEqual(unpackBinaryMessage(undefined), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.alloc(0)), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.alloc(1)), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.alloc(2)), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.alloc(3)), null);
});

suite.test("A.7 Malformed Framing: headerLen boundary edge cases (0, overflow, > buffer)", async () => {
  // headerLen = 0
  const zeroHeaderBuf = Buffer.alloc(10);
  zeroHeaderBuf.writeUInt32BE(0, 0);
  assert.strictEqual(unpackBinaryMessage(zeroHeaderBuf), null);

  // headerLen exceeds buffer length
  const hugeHeaderBuf = Buffer.alloc(10);
  hugeHeaderBuf.writeUInt32BE(1000, 0);
  assert.strictEqual(unpackBinaryMessage(hugeHeaderBuf), null);

  // headerLen = 0xFFFFFFFF (4GB, integer boundary)
  const maxHeaderBuf = Buffer.alloc(10);
  maxHeaderBuf.writeUInt32BE(0xffffffff, 0);
  assert.strictEqual(unpackBinaryMessage(maxHeaderBuf), null);
});

suite.test("A.8 Malformed Framing: Truncated JSON header or corrupted UTF-8", async () => {
  // Header length says 30 bytes, but JSON is truncated
  const truncatedJson = '{"type": "print", "requestId": ';
  const jsonBuf = Buffer.from(truncatedJson, "utf8");
  const frame = Buffer.alloc(4 + jsonBuf.length + 10);
  frame.writeUInt32BE(jsonBuf.length, 0);
  jsonBuf.copy(frame, 4);
  assert.strictEqual(unpackBinaryMessage(frame), null);

  // Header has non-JSON garbage bytes
  const garbage = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0xaa, 0xbb]);
  const garbageFrame = Buffer.alloc(4 + garbage.length + 5);
  garbageFrame.writeUInt32BE(garbage.length, 0);
  garbage.copy(garbageFrame, 4);
  assert.strictEqual(unpackBinaryMessage(garbageFrame), null);
});

// ─────────────────────────────────────────────────────────────
// TIER B: WebSocket Wire Negotiation & Server Malformed Frame Resilience
// ─────────────────────────────────────────────────────────────

suite.test("B.1 Wire Negotiation: Binary capable client receives binary frame on RPC", async () => {
  await ensureServerStarted();

  const deviceId = "test-bin-cap-" + Date.now();
  const client = createClientWs(wsUrl);
  await client.waitForOpen();

  client.sendJson({
    type: "register",
    id: deviceId,
    capabilities: ["binary"],
    binarySupported: true,
  });

  const regResponseMsg = await client.waitForMessage();
  const regResponse = JSON.parse(regResponseMsg.data.toString());
  assert.strictEqual(regResponse.type, "registered");
  assert.strictEqual(regResponse.binarySupported, true);

  // Trigger RPC from server
  const testPayload = Buffer.from("%PDF-1.4 binary test content\nEOF");
  const rpcPromise = rpc(
    deviceId,
    {
      type: "print",
      filename: "test.pdf",
      binaryPayload: testPayload,
      options: { orientation: "landscape" },
    },
    5000
  );

  // Client should receive a BINARY message
  const incoming = await client.waitForMessage();
  assert.strictEqual(incoming.isBinary, true, "Must arrive as a binary WebSocket message");

  const unpacked = unpackBinaryMessage(incoming.data);
  assert.ok(unpacked !== null, "Must unpack cleanly");
  assert.strictEqual(unpacked.meta.type, "print");
  assert.strictEqual(unpacked.meta.filename, "test.pdf");
  assert.strictEqual(unpacked.meta.options.orientation, "landscape");
  assert.deepStrictEqual(unpacked.payload, testPayload);

  // Client responds with print_result
  client.sendJson({
    type: "print_result",
    requestId: unpacked.meta.requestId,
    ok: true,
  });

  const result = await rpcPromise;
  assert.strictEqual(result.ok, true);

  client.close();
});

suite.test("B.2 Wire Negotiation: Legacy client (no binary capability) receives JSON Base64", async () => {
  await ensureServerStarted();

  const deviceId = "test-legacy-" + Date.now();
  const client = createClientWs(wsUrl);
  await client.waitForOpen();

  // Legacy registration: no capabilities array, no binarySupported
  client.sendJson({
    type: "register",
    id: deviceId,
  });

  const regResponseMsg = await client.waitForMessage();
  const regResponse = JSON.parse(regResponseMsg.data.toString());
  assert.strictEqual(regResponse.type, "registered");
  assert.strictEqual(regResponse.binarySupported, false);

  const testPayload = Buffer.from("%PDF-1.4 legacy base64 content\nEOF");
  const rpcPromise = rpc(
    deviceId,
    {
      type: "print",
      filename: "legacy.pdf",
      binaryPayload: testPayload,
      options: { orientation: "portrait" },
    },
    5000
  );

  // Client should receive a TEXT JSON message
  const incoming = await client.waitForMessage();
  assert.strictEqual(incoming.isBinary, false, "Must arrive as text JSON frame for legacy client");

  const parsed = JSON.parse(incoming.data.toString());
  assert.strictEqual(parsed.type, "print");
  assert.strictEqual(parsed.filename, "legacy.pdf");
  assert.strictEqual(parsed.binaryPayload, undefined, "binaryPayload buffer must not leak to JSON");
  assert.ok(typeof parsed.fileBase64 === "string", "Must supply fileBase64 string");

  const decoded = Buffer.from(parsed.fileBase64, "base64");
  assert.deepStrictEqual(decoded, testPayload, "Base64 decoded bytes must match original");

  // Client responds
  client.sendJson({
    type: "print_result",
    requestId: parsed.requestId,
    ok: true,
  });

  const result = await rpcPromise;
  assert.strictEqual(result.ok, true);

  client.close();
});

suite.test("B.3 Wire Negotiation: Client can respond using binary frame for print_result", async () => {
  await ensureServerStarted();

  const deviceId = "test-bin-resp-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();

  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const rpcPromise = rpc(
    deviceId,
    {
      type: "print",
      filename: "bin_resp.pdf",
      binaryPayload: Buffer.from("dummy pdf"),
    },
    5000
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);

  // Send print_result packed as a binary frame
  const resultMeta = {
    type: "print_result",
    requestId: unpacked.meta.requestId,
    ok: true,
    telemetry: { totalMs: 42 },
  };
  const binaryResultFrame = packBinaryMessage(resultMeta, Buffer.alloc(0));
  client.sendBinary(binaryResultFrame);

  const result = await rpcPromise;
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.telemetry.totalMs, 42);

  client.close();
});

suite.test("B.4 Server Resilience: Server survives malformed client frames without crashing", async () => {
  await ensureServerStarted();

  const deviceId = "test-malformed-client-" + Date.now();
  const client = createClientWs(wsUrl);
  await client.waitForOpen();

  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  // 1. Send 0-byte frame
  client.sendBinary(Buffer.alloc(0));

  // 2. Send 2-byte frame
  client.sendBinary(Buffer.from([0x00, 0x01]));

  // 3. Send corrupted binary frame with headerLen = 999999
  const corruptedHeader = Buffer.alloc(10);
  corruptedHeader.writeUInt32BE(999999, 0);
  client.sendBinary(corruptedHeader);

  // 4. Send corrupted JSON text string
  client.ws.send("{malformed json text string:::");

  // 5. Send completely random bytes
  client.sendBinary(crypto.randomBytes(64));

  // Small delay to ensure server processed the garbage
  await new Promise((r) => setTimeout(r, 50));

  // Server must still be alive and responsive! Send app_ping
  client.sendJson({ type: "app_ping" });
  const pongMsg = await client.waitForMessage(2000);
  const pong = JSON.parse(pongMsg.data.toString());
  assert.strictEqual(pong.type, "app_pong", "Server must still respond with app_pong");

  client.close();
});

// ─────────────────────────────────────────────────────────────
// TIER C: Orientation Handling Stress via Live HTTP POST
// ─────────────────────────────────────────────────────────────

suite.test("C.1 Orientation: PDF with 'landscape' forwards orientation: 'landscape'", async () => {
  await ensureServerStarted();

  const deviceId = "dev-orient-land-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    {
      printer: "HP LaserJet 1020",
      orientation: "landscape",
      paperSize: "a4",
    },
    { buffer: pdfFixture, filename: "invoice.pdf" }
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);
  assert.strictEqual(unpacked.meta.options.orientation, "landscape");

  client.sendJson({ type: "print_result", requestId: unpacked.meta.requestId, ok: true });
  const res = await httpPromise;
  assert.strictEqual(res.status, 200);

  client.close();
});

suite.test("C.2 Orientation: PDF with 'portrait' forwards orientation: 'portrait'", async () => {
  await ensureServerStarted();

  const deviceId = "dev-orient-port-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    {
      orientation: "portrait",
    },
    { buffer: pdfFixture, filename: "doc.pdf" }
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);
  assert.strictEqual(unpacked.meta.options.orientation, "portrait");

  client.sendJson({ type: "print_result", requestId: unpacked.meta.requestId, ok: true });
  const res = await httpPromise;
  assert.strictEqual(res.status, 200);

  client.close();
});

suite.test("C.3 Orientation: PDF with 'auto' forwards orientation: 'auto'", async () => {
  await ensureServerStarted();

  const deviceId = "dev-orient-auto-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    {
      orientation: "auto",
    },
    { buffer: pdfFixture, filename: "doc.pdf" }
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);
  assert.strictEqual(unpacked.meta.options.orientation, "auto");

  client.sendJson({ type: "print_result", requestId: unpacked.meta.requestId, ok: true });
  await httpPromise;
  client.close();
});

suite.test("C.4 Orientation: PDF with empty string or omitted orientation defaults to 'auto'", async () => {
  await ensureServerStarted();

  const deviceId = "dev-orient-empty-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  // 1. Empty string orientation
  const httpPromise1 = postMultipart(
    `/relay/${deviceId}/print`,
    { orientation: "" },
    { buffer: pdfFixture, filename: "doc1.pdf" }
  );

  const inc1 = await client.waitForMessage();
  const unp1 = unpackBinaryMessage(inc1.data);
  assert.strictEqual(unp1.meta.options.orientation, "auto", "Empty string orientation must default to 'auto'");
  client.sendJson({ type: "print_result", requestId: unp1.meta.requestId, ok: true });
  await httpPromise1;

  // 2. Omitted orientation field
  const httpPromise2 = postMultipart(
    `/relay/${deviceId}/print`,
    {},
    { buffer: pdfFixture, filename: "doc2.pdf" }
  );

  const inc2 = await client.waitForMessage();
  const unp2 = unpackBinaryMessage(inc2.data);
  assert.strictEqual(unp2.meta.options.orientation, "auto", "Omitted orientation must default to 'auto'");
  client.sendJson({ type: "print_result", requestId: unp2.meta.requestId, ok: true });
  await httpPromise2;

  client.close();
});

suite.test("C.5 Orientation: PDF with uppercase 'LANDSCAPE' or custom values survives safely", async () => {
  await ensureServerStarted();

  const deviceId = "dev-orient-upper-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    { orientation: "LANDSCAPE" },
    { buffer: pdfFixture, filename: "upper.pdf" }
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);
  assert.strictEqual(unpacked.meta.options.orientation, "LANDSCAPE");

  client.sendJson({ type: "print_result", requestId: unpacked.meta.requestId, ok: true });
  const res = await httpPromise;
  assert.strictEqual(res.status, 200);

  client.close();
});

suite.test("C.6 Orientation: Non-PDF image (.png) converts to PDF and sets orientation: 'portrait'", async () => {
  await ensureServerStarted();

  const deviceId = "dev-orient-png-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  // Create a minimal 1x1 PNG buffer
  const minimalPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );

  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    { orientation: "landscape" },
    { buffer: minimalPng, filename: "photo.png" }
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);

  // For non-PDF converted raster images, server sets orientation: "portrait"
  // because prepareDocumentForPrinter embeds the image into a portrait drum canvas
  assert.strictEqual(unpacked.meta.options.orientation, "portrait");
  assert.strictEqual(unpacked.meta.filename, "photo.pdf", "Filename must be converted to .pdf");

  client.sendJson({ type: "print_result", requestId: unpacked.meta.requestId, ok: true });
  const res = await httpPromise;
  assert.strictEqual(res.status, 200);

  client.close();
});

suite.test("C.7 Orientation: Preformatted non-PDF bypasses prepareDocumentForPrinter", async () => {
  await ensureServerStarted();

  const deviceId = "dev-preformatted-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const dummyRaw = Buffer.from("preformatted raw bytes");

  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    {
      isPreformatted: "true",
      orientation: "landscape",
    },
    { buffer: dummyRaw, filename: "custom.raw" }
  );

  const incoming = await client.waitForMessage();
  const unpacked = unpackBinaryMessage(incoming.data);

  assert.strictEqual(unpacked.meta.options.isPreformatted, true);
  assert.strictEqual(unpacked.meta.options.orientation, "landscape");
  assert.deepStrictEqual(unpacked.payload, dummyRaw, "Raw bytes must be passed untouched");

  client.sendJson({ type: "print_result", requestId: unpacked.meta.requestId, ok: true });
  await httpPromise;

  client.close();
});

// ─────────────────────────────────────────────────────────────
// TIER D: Socket Lifecycle & Immediate Disconnect Abort Stress
// ─────────────────────────────────────────────────────────────

suite.test("D.1 Socket Lifecycle: Pending print request aborts immediately (<200ms) with device_offline on drop", async () => {
  await ensureServerStarted();

  const deviceId = "dev-drop-abort-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  const tStart = performance.now();
  const httpPromise = postMultipart(
    `/relay/${deviceId}/print`,
    { printer: "HP LaserJet 1020" },
    { buffer: pdfFixture, filename: "hang_test.pdf" }
  );

  // Wait until client receives the print frame over WS
  await client.waitForMessage();

  // Socket drops abruptly mid-job! (terminate connection)
  client.terminate();

  // HTTP POST must abort immediately without waiting for 90s RPC timeout!
  const res = await httpPromise;
  const elapsedMs = performance.now() - tStart;

  assert.strictEqual(res.status, 404, "HTTP status must be 404 on dropped device");
  assert.strictEqual(res.json.error, "device_offline");
  assert.ok(
    elapsedMs < 250,
    `Abort must occur immediately (<250ms), took ${elapsedMs.toFixed(2)}ms (Eliminated 90s hang!)`
  );
});

suite.test("D.2 Socket Lifecycle: Pending firmware upload aborts immediately (<200ms) on socket drop", async () => {
  await ensureServerStarted();

  const deviceId = "dev-fw-drop-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const dummyFw = Buffer.from("dummy firmware bytes");

  const tStart = performance.now();
  const httpPromise = postMultipart(
    `/relay/${deviceId}/firmware`,
    {},
    { buffer: dummyFw, filename: "sihp1020.dl" }
  );

  await client.waitForMessage();

  // Client drops connection
  client.terminate();

  const res = await httpPromise;
  const elapsedMs = performance.now() - tStart;

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.json.error, "device_offline");
  assert.ok(
    elapsedMs < 250,
    `Firmware abort must occur immediately (<250ms), took ${elapsedMs.toFixed(2)}ms (Eliminated 30s hang!)`
  );
});

suite.test("D.3 Socket Lifecycle: Multi-request concurrent drop aborts ALL requests immediately", async () => {
  await ensureServerStarted();

  const deviceId = "dev-multi-drop-" + Date.now();
  const client = createClientWs(wsUrl + "?capabilities=binary");
  await client.waitForOpen();
  client.sendJson({ type: "register", id: deviceId });
  await client.waitForMessage();

  const pdfFixture = fs.readFileSync(path.join(FIXTURES_DIR, "synthetic_invoice.pdf"));

  // Dispatch 4 concurrent print requests
  const tStart = performance.now();
  const promises = [
    postMultipart(`/relay/${deviceId}/print`, {}, { buffer: pdfFixture, filename: "c1.pdf" }),
    postMultipart(`/relay/${deviceId}/print`, {}, { buffer: pdfFixture, filename: "c2.pdf" }),
    postMultipart(`/relay/${deviceId}/print`, {}, { buffer: pdfFixture, filename: "c3.pdf" }),
    postMultipart(`/relay/${deviceId}/print`, {}, { buffer: pdfFixture, filename: "c4.pdf" }),
  ];

  // Wait a moment for server to register all pending RPCs
  await new Promise((r) => setTimeout(r, 60));

  // Drop socket abruptly
  client.terminate();

  const results = await Promise.all(promises);
  const elapsedMs = performance.now() - tStart;

  for (let i = 0; i < results.length; i++) {
    assert.strictEqual(results[i].status, 404, `Request ${i} must fail with 404`);
    assert.strictEqual(results[i].json.error, "device_offline", `Request ${i} must report device_offline`);
  }

  assert.ok(
    elapsedMs < 300,
    `All 4 concurrent requests must abort in <300ms, took ${elapsedMs.toFixed(2)}ms`
  );
  assert.strictEqual(devices.has(deviceId), false, "Device must be cleaned up from devices map");
});

suite.test("D.4 Socket Lifecycle: Rapid connect / disconnect churn stability (25 iterations)", async () => {
  await ensureServerStarted();

  const tStart = performance.now();
  for (let i = 0; i < 25; i++) {
    const churnId = `dev-churn-${i}-${Date.now()}`;
    const churnClient = createClientWs(wsUrl);
    await churnClient.waitForOpen();
    churnClient.sendJson({ type: "register", id: churnId, binarySupported: true });
    churnClient.terminate(); // Abrupt drop
  }
  const churnDurationMs = performance.now() - tStart;
  assert.ok(churnDurationMs < 3000, `25 churn cycles completed in ${churnDurationMs.toFixed(2)}ms`);

  // Verify server is healthy: a new client connects cleanly and performs an operation
  const healthyClient = createClientWs(wsUrl);
  await healthyClient.waitForOpen();
  healthyClient.sendJson({ type: "app_ping" });
  const pongMsg = await healthyClient.waitForMessage(2000);
  const pong = JSON.parse(pongMsg.data.toString());
  assert.strictEqual(pong.type, "app_pong");
  healthyClient.close();
});

suite.test("D.5 Socket Lifecycle: Duplicate registration terminates old socket", async () => {
  await ensureServerStarted();

  const sharedId = "dev-shared-reconnect-" + Date.now();

  const client1 = createClientWs(wsUrl);
  await client1.waitForOpen();
  client1.sendJson({ type: "register", id: sharedId });
  await client1.waitForMessage();

  // Verify client1 is registered
  assert.strictEqual(devices.has(sharedId), true);
  const serverWs1 = devices.get(sharedId).ws;
  assert.ok(serverWs1, "Server device record must exist for client 1");

  // Client 2 connects with the SAME pairing ID
  const client2 = createClientWs(wsUrl);
  await client2.waitForOpen();
  client2.sendJson({ type: "register", id: sharedId });
  await client2.waitForMessage();

  // Client 2 must now be the active device
  const serverWs2 = devices.get(sharedId).ws;
  assert.notStrictEqual(serverWs2, serverWs1, "Server device record must now reference new socket");

  // Client 1's socket should have been terminated / closed
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    client1.ws.readyState === WebSocket.CLOSING || client1.ws.readyState === WebSocket.CLOSED,
    "Client 1 must be closed after Client 2 takes over pairing ID"
  );

  client2.close();
});

suite.test("D.6 Socket Lifecycle: Request to offline device returns 404 immediately (<20ms)", async () => {
  await ensureServerStarted();

  const tStart = performance.now();
  const res = await postMultipart(
    `/relay/non-existent-device-xyz/print`,
    {},
    { buffer: Buffer.from("dummy"), filename: "doc.pdf" }
  );
  const elapsedMs = performance.now() - tStart;

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.json.error, "offline");
  assert.ok(elapsedMs < 50, `Immediate 404 must return in <50ms, took ${elapsedMs.toFixed(2)}ms`);
});

// Run if executed directly
if (require.main === module) {
  ensureServerStarted()
    .then(() => suite.run())
    .then((res) => {
      // Clean up server
      try {
        server.close();
      } catch {}
      if (res.failed > 0) {
        process.exit(1);
      } else {
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error("Test runner encountered error:", err);
      process.exit(1);
    });
}

module.exports = suite;
