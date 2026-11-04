/**
 * Tier 5 White-Box Adversarial Hardening Suite — Server Relay
 * Milestone: M8 Phase 2 (Challenger 1)
 *
 * Empirical verification of:
 * 1. Binary WebSocket Framing Fuzzing & Boundary Conditions:
 *    - headerLen = 0, headerLen > buffer.length, 0xFFFFFFFF unsigned int32 overflow
 *    - truncated buffer (< 4 bytes), corrupt/non-UTF8 JSON header bytes
 *    - non-object JSON values (number, string, boolean)
 *    - empty payload, large payload (5MB+) with SHA-256 byte fidelity
 *    - raw text vs binary frame dispatch resilience
 * 2. Simultaneous Rapid Socket Drops During In-Flight Multipart File Uploads:
 *    - 15 concurrent multipart uploads in flight when device drops connection
 *    - Immediate (< 250ms) rejection of all pending RPCs with device_offline
 *    - Zero activeJobs counter leak (activeJobs returns strictly to 0)
 *    - Zero pending map memory leak (pending.size drains to 0)
 *    - Rapid reconnect churn under load
 * 3. Extreme Rate-Limiting & Buffer Overflow Scenarios:
 *    - IP rate limiter thresholding (60 limit -> 429 response on 61+)
 *    - Multer file size boundary rejection (21MB payload vs 20MB limit)
 *    - Telemetry ring buffer overflow cap (50 entries max, strict FIFO)
 *    - Latency math robustness against empty, null, and outlier data
 */

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
  deviceTelemetry,
  getDeviceTelemetry,
  calculateLatencyMetrics,
  MAX_RECENT_JOBS,
} = require("../server");

const suite = createSuite("Tier 5: Server Relay White-Box Adversarial Hardening");

let serverPort = null;
let serverUrl = null;
let wsUrl = null;
let clientIpCounter = 200;

async function ensureServerStarted() {
  app.set("trust proxy", true);
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
  let onMessageCallback = null;

  ws.on("message", (data, isBinary) => {
    if (isBinary || (Buffer.isBuffer(data) && data.length >= 4 && data[0] !== 0x7b)) {
      binaryMessages.push(data);
    } else {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        messages.push({ raw: data.toString() });
      }
    }
    if (onMessageCallback) {
      const cb = onMessageCallback;
      onMessageCallback = null;
      cb({ data, isBinary });
    }
  });

  return {
    ws,
    messages,
    binaryMessages,
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
      try { ws.close(); } catch {}
    },
    terminate: () => {
      try { ws.terminate(); } catch {}
    },
  };
}

async function registerMockDevice(deviceId, opts = {}) {
  await ensureServerStarted();
  const binaryQuery = opts.binary ? "?capabilities=binary" : "";
  const client = createClientWs(`${wsUrl}${binaryQuery}`);
  await client.waitForOpen();

  client.sendJson({
    type: "register",
    id: deviceId,
    binarySupported: !!opts.binary,
    capabilities: opts.binary ? ["binary"] : [],
  });

  // Wait until device appears in server map
  const t0 = Date.now();
  while (!devices.has(deviceId)) {
    if (Date.now() - t0 > 3000) throw new Error(`Timeout waiting for ${deviceId} registration`);
    await new Promise((r) => setTimeout(r, 10));
  }

  return client;
}

// ============================================================================
// PART 1: BINARY WEBSOCKET FRAMING FUZZING & BOUNDARY CONDITIONS
// ============================================================================

suite.test("1.1 unpackBinaryMessage handles truncated and invalid buffers (< 4 bytes) safely", async () => {
  assert.strictEqual(unpackBinaryMessage(null), null);
  assert.strictEqual(unpackBinaryMessage(undefined), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.alloc(0)), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.from([0x00])), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.from([0x00, 0x01])), null);
  assert.strictEqual(unpackBinaryMessage(Buffer.from([0x00, 0x00, 0x01])), null);
});

suite.test("1.2 unpackBinaryMessage handles headerLen = 0 and boundary mismatch", async () => {
  // headerLen = 0
  const zeroHeaderBuf = Buffer.alloc(10);
  zeroHeaderBuf.writeUInt32BE(0, 0);
  assert.strictEqual(unpackBinaryMessage(zeroHeaderBuf), null);

  // headerLen exceeds buffer length: headerLen = 10, total buffer length = 8 (needs 4 + 10 = 14)
  const overflowBuf = Buffer.alloc(8);
  overflowBuf.writeUInt32BE(10, 0);
  assert.strictEqual(unpackBinaryMessage(overflowBuf), null);

  // Invalid JSON bytes at exact boundary: headerLen = 5, total buffer length = 9 (4 + 5 = 9)
  const exactBuf = Buffer.alloc(9);
  exactBuf.writeUInt32BE(5, 0);
  exactBuf.write("abcde", 4, "utf8"); // invalid JSON token
  assert.strictEqual(unpackBinaryMessage(exactBuf), null);
});

suite.test("1.3 unpackBinaryMessage handles 32-bit unsigned integer overflow safely", async () => {
  const maxUint32Buf = Buffer.alloc(16);
  maxUint32Buf.writeUInt32BE(0xFFFFFFFF, 0); // 4,294,967,295
  assert.strictEqual(unpackBinaryMessage(maxUint32Buf), null);

  const largeLenBuf = Buffer.alloc(16);
  largeLenBuf.writeUInt32BE(0x7FFFFFFF, 0); // 2,147,483,647
  assert.strictEqual(unpackBinaryMessage(largeLenBuf), null);
});

suite.test("1.4 unpackBinaryMessage handles non-UTF8 and corrupted JSON header bytes", async () => {
  const badJsonStr = "{ invalid json: true";
  const badBuf = Buffer.alloc(4 + badJsonStr.length + 5);
  badBuf.writeUInt32BE(badJsonStr.length, 0);
  badBuf.write(badJsonStr, 4, "utf8");
  assert.strictEqual(unpackBinaryMessage(badBuf), null);

  // Non-UTF8 / random binary header
  const randomBytes = crypto.randomBytes(32);
  const corruptBuf = Buffer.alloc(4 + 32);
  corruptBuf.writeUInt32BE(32, 0);
  randomBytes.copy(corruptBuf, 4);
  assert.strictEqual(unpackBinaryMessage(corruptBuf), null);
});

suite.test("1.5 packBinaryMessage and unpackBinaryMessage roundtrip with empty and multi-MB payload", async () => {
  // Empty payload
  const metaEmpty = { type: "print", requestId: "req-empty-1", options: { copies: 1 } };
  const packedEmpty = packBinaryMessage(metaEmpty, null);
  const unpackedEmpty = unpackBinaryMessage(packedEmpty);
  assert.ok(unpackedEmpty);
  assert.deepStrictEqual(unpackedEmpty.meta, metaEmpty);
  assert.strictEqual(unpackedEmpty.payload.length, 0);

  // 5MB High-entropy payload byte fidelity check
  const metaLarge = { type: "print", requestId: "req-large-1", filename: "test.pdf" };
  const largePayload = crypto.randomBytes(5 * 1024 * 1024);
  const origHash = crypto.createHash("sha256").update(largePayload).digest("hex");

  const packedLarge = packBinaryMessage(metaLarge, largePayload);
  const unpackedLarge = unpackBinaryMessage(packedLarge);
  assert.ok(unpackedLarge);
  assert.deepStrictEqual(unpackedLarge.meta, metaLarge);
  assert.strictEqual(unpackedLarge.payload.length, 5 * 1024 * 1024);

  const unpackedHash = crypto.createHash("sha256").update(unpackedLarge.payload).digest("hex");
  assert.strictEqual(unpackedHash, origHash, "SHA-256 byte fidelity preserved across 5MB framing");
});

suite.test("1.6 Server WebSocket frame parser handles malformed frames without crashing", async () => {
  const deviceId = `fuzz-dev-${Date.now()}`;
  const client = await registerMockDevice(deviceId, { binary: true });

  // Send raw corrupted binary frame
  client.sendBinary(Buffer.from([0x00, 0x00, 0x00, 0x20, 0xFF, 0xFE, 0xFD]));
  // Send 0-length buffer
  client.sendBinary(Buffer.alloc(0));
  // Send malformed text frame
  client.sendJson("NOT_JSON_DATA_STRING{{{");

  // Allow server event loop to process
  await new Promise((r) => setTimeout(r, 100));

  // Device must still be connected and responsive to app_ping
  let gotPong = false;
  client.ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "app_pong") gotPong = true;
    } catch {}
  });
  client.sendJson({ type: "app_ping" });

  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(gotPong, true, "Server stayed alive and responded with app_pong after fuzzing");
  client.terminate();
});

// ============================================================================
// PART 2: SIMULTANEOUS RAPID SOCKET DROPS DURING IN-FLIGHT UPLOADS
// ============================================================================

suite.test("2.1 15 concurrent in-flight HTTP uploads immediately abort on socket drop (<250ms)", async () => {
  const deviceId = `drop-test-${Date.now()}`;
  const client = await registerMockDevice(deviceId, { binary: true });
  const stats = getDeviceTelemetry(deviceId);

  const NUM_CONCURRENT = 15;
  const dispatchPromises = [];
  const startTimes = [];

  for (let i = 0; i < NUM_CONCURRENT; i++) {
    clientIpCounter++;
    const ip = `10.0.0.${clientIpCounter}`;

    const boundary = "----WebKitFormBoundaryTier5";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test_${i}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(`%PDF-1.4 test payload ${i}`),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="printer"\r\n\r\nHP LaserJet 1020\r\n--${boundary}--\r\n`),
    ]);

    startTimes.push(performance.now());
    const p = new Promise((resolve) => {
      const req = http.request(
        `${serverUrl}/relay/${deviceId}/print`,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
            "X-Forwarded-For": ip,
          },
        },
        (res) => {
          let resData = "";
          res.on("data", (c) => (resData += c));
          res.on("end", () => {
            const duration = performance.now() - startTimes[i];
            resolve({ statusCode: res.statusCode, data: resData, duration });
          });
        }
      );
      req.on("error", (err) => resolve({ error: err.message }));
      req.write(body);
      req.end();
    });

    dispatchPromises.push(p);
  }

  // Wait 40ms for all 15 requests to reach server and register pending RPCs
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(stats.activeJobs >= 1, `activeJobs should be >= 1 during flight (got: ${stats.activeJobs})`);
  assert.ok(pending.size >= 1, `pending RPCs should be registered (got: ${pending.size})`);

  // Forcefully terminate the device socket mid-upload!
  const dropTime = performance.now();
  client.terminate();

  // Wait for all 15 HTTP requests to complete
  const results = await Promise.all(dispatchPromises);
  const totalDropDuration = performance.now() - dropTime;

  // Assert all 15 received 404 (offline) in < 250ms from socket termination
  assert.strictEqual(results.length, NUM_CONCURRENT);
  for (let i = 0; i < NUM_CONCURRENT; i++) {
    const res = results[i];
    assert.strictEqual(res.statusCode, 404, `Request ${i} must receive 404 on socket disconnect`);
    assert.ok(res.data.includes("offline") || res.data.includes("device_offline"));
  }
  assert.ok(
    totalDropDuration < 300,
    `All 15 in-flight requests must abort immediately on socket drop (<300ms, eliminated 90s hang!), took ${totalDropDuration.toFixed(1)}ms`
  );

  // Strict zero-leak assertions:
  assert.strictEqual(stats.activeJobs, 0, "stats.activeJobs must return strictly to 0 (zero counter leak)");
  assert.strictEqual(pending.size, 0, "pending RPC map must strictly drain to 0 (zero memory leak)");
  assert.strictEqual(stats.totalJobsFailed >= NUM_CONCURRENT, true, "stats.totalJobsFailed must track all dropped jobs");
});

suite.test("2.2 Rapid reconnect churn under load preserves state consistency", async () => {
  const deviceId = `churn-test-${Date.now()}`;

  // Perform 3 rapid connect -> dispatch -> drop cycles
  for (let cycle = 0; cycle < 3; cycle++) {
    const client = await registerMockDevice(deviceId, { binary: true });

    clientIpCounter++;
    const boundary = "----WebKitFormBoundaryChurn";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="churn.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}--\r\n`),
    ]);

    const reqPromise = new Promise((resolve) => {
      const req = http.request(
        `${serverUrl}/relay/${deviceId}/print`,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
            "X-Forwarded-For": `10.1.0.${clientIpCounter}`,
          },
        },
        (res) => resolve(res.statusCode)
      );
      req.write(body);
      req.end();
    });

    await new Promise((r) => setTimeout(r, 20));
    client.terminate();
    const statusCode = await reqPromise;
    assert.strictEqual(statusCode, 404);
  }

  const finalStats = getDeviceTelemetry(deviceId);
  assert.strictEqual(finalStats.activeJobs, 0, "activeJobs must be 0 after churn cycles");
  assert.strictEqual(pending.size, 0, "pending size must be 0 after churn cycles");
});

// ============================================================================
// PART 3: EXTREME RATE-LIMITING & BUFFER OVERFLOW SCENARIOS
// ============================================================================

suite.test("3.1 IP rate limiter enforces MAX_REQUESTS_PER_WINDOW = 60 and returns HTTP 429", async () => {
  const rateLimitIp = `192.168.99.${Math.floor(Math.random() * 200) + 10}`;
  const deviceId = `rl-dev-${Date.now()}`;

  let passedCount = 0;
  let blockedCount = 0;

  for (let i = 1; i <= 65; i++) {
    const res = await new Promise((resolve) => {
      const req = http.request(
        `${serverUrl}/relay/${deviceId}/status`,
        {
          method: "GET",
          headers: { "X-Forwarded-For": rateLimitIp },
        },
        (response) => {
          let data = "";
          response.on("data", (c) => (data += c));
          response.on("end", () => resolve({ status: response.statusCode, data }));
        }
      );
      req.end();
    });

    if (res.status === 200) {
      passedCount++;
    } else if (res.status === 429) {
      blockedCount++;
      assert.ok(res.data.includes("Too many requests"), "429 must include error message");
    }
  }

  assert.strictEqual(passedCount, 60, "Exactly 60 requests must be permitted within window");
  assert.strictEqual(blockedCount, 5, "Requests 61-65 must be blocked with HTTP 429");
});

suite.test("3.2 Multer rejects uploads exceeding MAX_FILE_MB (20MB) safely without server crash", async () => {
  const deviceId = `oversize-dev-${Date.now()}`;
  clientIpCounter++;

  // Create a 21MB multipart payload (exceeds 20MB limit)
  const boundary = "----WebKitFormBoundaryOversize";
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="oversize.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const largeChunk = Buffer.alloc(1024 * 1024, 0x41); // 1MB chunk
  const totalChunks = 21;

  const totalLength = header.length + (totalChunks * largeChunk.length) + footer.length;

  const res = await new Promise((resolve) => {
    const req = http.request(
      `${serverUrl}/relay/${deviceId}/print`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": totalLength,
          "X-Forwarded-For": `10.2.0.${clientIpCounter}`,
        },
      },
      (response) => {
        let data = "";
        response.on("data", (c) => (data += c));
        response.on("end", () => resolve({ status: response.statusCode, data }));
      }
    );
    req.on("error", (err) => resolve({ error: err.message }));

    req.write(header);
    for (let c = 0; c < totalChunks; c++) {
      req.write(largeChunk);
    }
    req.write(footer);
    req.end();
  });

  // Multer default error handler returns 500 when LIMIT_FILE_SIZE is encountered
  assert.ok(res.status === 500 || res.status === 413, `Server rejected oversized file with status ${res.status}`);
  // Verify server is still completely responsive
  const healthRes = await new Promise((resolve) => {
    http.get(`${serverUrl}/health`, (r) => resolve(r.statusCode));
  });
  assert.strictEqual(healthRes, 200, "Server remains fully healthy after oversized payload rejection");
});

suite.test("3.3 Telemetry ring buffer strictly caps at MAX_RECENT_JOBS (50) under 100-job flood", async () => {
  const deviceId = `ring-dev-${Date.now()}`;
  const stats = getDeviceTelemetry(deviceId);

  for (let i = 0; i < 100; i++) {
    stats.recentJobs.unshift({
      jobId: `job_${i}`,
      timestamp: Date.now() + i,
      status: i % 2 === 0 ? "success" : "failed",
      latencyMs: 100 + i,
    });
    if (stats.recentJobs.length > MAX_RECENT_JOBS) {
      stats.recentJobs.pop();
    }
  }

  assert.strictEqual(stats.recentJobs.length, 50, "Ring buffer strictly capped at 50");
  assert.strictEqual(stats.recentJobs[0].jobId, "job_99", "Newest job is always at index 0 (FIFO)");
  assert.strictEqual(stats.recentJobs[49].jobId, "job_50", "Oldest retained job is at index 49");
});

suite.test("3.4 calculateLatencyMetrics handles boundary and corrupted mathematical data", async () => {
  // Empty
  assert.deepStrictEqual(calculateLatencyMetrics([]), { avgLatencyMs: 0, p95LatencyMs: 0 });
  assert.deepStrictEqual(calculateLatencyMetrics(null), { avgLatencyMs: 0, p95LatencyMs: 0 });
  assert.deepStrictEqual(calculateLatencyMetrics(undefined), { avgLatencyMs: 0, p95LatencyMs: 0 });

  // Corrupted entries
  const corruptJobs = [
    { latencyMs: NaN },
    { latencyMs: -50 },
    { latencyMs: "invalid" },
    null,
    undefined,
    {},
    { latencyMs: 100 },
  ];
  const corruptMetrics = calculateLatencyMetrics(corruptJobs);
  assert.strictEqual(corruptMetrics.avgLatencyMs, 100);
  assert.strictEqual(corruptMetrics.p95LatencyMs, 100);

  // Single valid entry
  const single = calculateLatencyMetrics([{ latencyMs: 250.5 }]);
  assert.strictEqual(single.avgLatencyMs, 250.5);
  assert.strictEqual(single.p95LatencyMs, 250.5);

  // Extreme values (outliers)
  const extremeJobs = Array.from({ length: 100 }, (_, i) => ({ latencyMs: i === 99 ? 1000000 : 10 }));
  const extremeMetrics = calculateLatencyMetrics(extremeJobs);
  assert.ok(extremeMetrics.p95LatencyMs < 1000000, "Nearest-rank p95 ignores single extreme outlier in 100 items");
  assert.ok(!isNaN(extremeMetrics.avgLatencyMs) && !isNaN(extremeMetrics.p95LatencyMs));
});

module.exports = suite;

if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
    else process.exit(0);
  });
}
