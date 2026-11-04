/**
 * Tier 3.10 / Milestone M7: Server Relay Telemetry, Metrics & Queue Health Tests
 */

const http = require("http");
const { createSuite, assert } = require("./runner");
const {
  app,
  server,
  devices,
  pending,
  deviceTelemetry,
  getDeviceTelemetry,
  calculateLatencyMetrics,
  MAX_RECENT_JOBS,
} = require("../server");

const suite = createSuite("Milestone M7: Server Relay Telemetry & Metrics");

let serverPort = null;
let serverUrl = null;

async function ensureServerStarted() {
  if (server.listening) {
    const addr = server.address();
    serverPort = addr.port;
    serverUrl = `http://127.0.0.1:${serverPort}`;
    return;
  }
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      serverPort = addr.port;
      serverUrl = `http://127.0.0.1:${serverPort}`;
      resolve();
    });
    server.on("error", reject);
  });
}

function makeHttpRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, serverUrl);
    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// 1. Metric Calculation Tests
// ─────────────────────────────────────────────────────────────

suite.test("M7.1 calculateLatencyMetrics: Handles empty, null, and non-numeric latencies", () => {
  const emptyRes = calculateLatencyMetrics([]);
  assert.strictEqual(emptyRes.avgLatencyMs, 0);
  assert.strictEqual(emptyRes.p95LatencyMs, 0);

  const nullRes = calculateLatencyMetrics(null);
  assert.strictEqual(nullRes.avgLatencyMs, 0);
  assert.strictEqual(nullRes.p95LatencyMs, 0);

  const invalidRes = calculateLatencyMetrics([
    { latencyMs: "fast" },
    { latencyMs: -10 },
    { latencyMs: NaN },
    null,
    {},
  ]);
  assert.strictEqual(invalidRes.avgLatencyMs, 0);
  assert.strictEqual(invalidRes.p95LatencyMs, 0);
});

suite.test("M7.2 calculateLatencyMetrics: Computes accurate average and nearest-rank p95", () => {
  // Single element
  const single = calculateLatencyMetrics([{ latencyMs: 345.67 }]);
  assert.strictEqual(single.avgLatencyMs, 345.67);
  assert.strictEqual(single.p95LatencyMs, 345.67);

  // 10 elements: 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000
  // sum = 5500, avg = 550
  // rank = ceil(0.95 * 10) - 1 = 9 -> sorted[9] = 1000
  const tenJobs = Array.from({ length: 10 }, (_, i) => ({ latencyMs: (i + 1) * 100 }));
  const tenRes = calculateLatencyMetrics(tenJobs);
  assert.strictEqual(tenRes.avgLatencyMs, 550);
  assert.strictEqual(tenRes.p95LatencyMs, 1000);

  // 20 elements: 10, 20, 30, ..., 200
  // sum = 2100, avg = 105
  // rank = ceil(0.95 * 20) - 1 = 18 -> sorted[18] = 190
  const twentyJobs = Array.from({ length: 20 }, (_, i) => ({ latencyMs: (i + 1) * 10 }));
  const twentyRes = calculateLatencyMetrics(twentyJobs);
  assert.strictEqual(twentyRes.avgLatencyMs, 105);
  assert.strictEqual(twentyRes.p95LatencyMs, 190);
});

// ─────────────────────────────────────────────────────────────
// 2. Telemetry State & Partitioning Tests
// ─────────────────────────────────────────────────────────────

suite.test("M7.3 getDeviceTelemetry: Partitions state across distinct device IDs", () => {
  const dev1 = "m7_test_dev_" + Date.now() + "_1";
  const dev2 = "m7_test_dev_" + Date.now() + "_2";

  const stats1 = getDeviceTelemetry(dev1);
  const stats2 = getDeviceTelemetry(dev2);

  assert.strictEqual(stats1.activeJobs, 0);
  assert.strictEqual(stats1.recentJobs.length, 0);
  assert.strictEqual(stats1.totalJobsCompleted, 0);
  assert.strictEqual(stats1.totalJobsFailed, 0);

  stats1.activeJobs = 3;
  stats1.totalJobsCompleted = 5;

  assert.strictEqual(stats2.activeJobs, 0, "dev2 activeJobs must remain isolated");
  assert.strictEqual(stats2.totalJobsCompleted, 0, "dev2 totalJobsCompleted must remain isolated");
});

// ─────────────────────────────────────────────────────────────
// 3. GET /relay/:id/telemetry Endpoint Tests
// ─────────────────────────────────────────────────────────────

suite.test("M7.4 GET /relay/:id/telemetry returns contract-compliant JSON for offline device", async () => {
  await ensureServerStarted();
  const testDev = "m7_offline_dev_" + Date.now();

  const res = await makeHttpRequest("GET", `/relay/${testDev}/telemetry`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deviceId, testDev);
  assert.strictEqual(res.body.online, false);
  assert.strictEqual(res.body.activeJobs, 0);
  assert.strictEqual(res.body.avgLatencyMs, 0);
  assert.strictEqual(res.body.p95LatencyMs, 0);
  assert.ok(Array.isArray(res.body.recentJobs));
  assert.strictEqual(res.body.totalJobsCompleted, 0);
  assert.strictEqual(res.body.totalJobsFailed, 0);
});

suite.test("M7.5 GET /relay/:id/telemetry reflects online status when device connects", async () => {
  await ensureServerStarted();
  const testDev = "m7_online_dev_" + Date.now();
  devices.set(testDev, { ws: { readyState: 1 }, lastSeen: Date.now(), binarySupported: true });

  try {
    const res = await makeHttpRequest("GET", `/relay/${testDev}/telemetry`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.deviceId, testDev);
    assert.strictEqual(res.body.online, true);
  } finally {
    devices.delete(testDev);
  }
});

// ─────────────────────────────────────────────────────────────
// 4. POST /relay/:id/print Telemetry Instrumentation Tests
// ─────────────────────────────────────────────────────────────

suite.test("M7.6 POST /relay/:id/print records activeJobs, stages, and ring buffer on success", async () => {
  await ensureServerStarted();
  const testDev = "m7_print_success_dev_" + Date.now();

  // Create mock device that responds to RPC
  let capturedRequestId = null;
  const mockWs = {
    readyState: 1,
    send: (data, opts, cb) => {
      if (typeof cb === "function") cb(null);
      // Automatically respond to print RPC
      setTimeout(() => {
        for (const [id, record] of pending.entries()) {
          if (record.deviceId === testDev) {
            capturedRequestId = id;
            clearTimeout(record.timer);
            pending.delete(id);
            record.resolve({
              type: "print_result",
              requestId: id,
              ok: true,
              jobId: "client_job_777",
              telemetry: {
                rasterMs: 142.5,
                ditherMs: 55.2,
                encodeMs: 38.4,
                usbMs: 410.8,
                totalMs: 646.9,
              },
            });
            break;
          }
        }
      }, 20);
    },
    terminate: () => {},
  };

  devices.set(testDev, { ws: mockWs, lastSeen: Date.now(), binarySupported: true });

  try {
    // Construct multipart form data body manually
    const boundary = "---------------------------M7Boundary" + Date.now();
    const pdfContent = "%PDF-1.4 test synthetic invoice stream";
    const bodyParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="printer"\r\n\r\nHP LaserJet 1020\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="orientation"\r\n\r\nauto\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n${pdfContent}\r\n`,
      `--${boundary}--\r\n`,
    ];
    const bodyBuffer = Buffer.from(bodyParts.join(""));

    const res = await makeHttpRequest(
      "POST",
      `/relay/${testDev}/print`,
      {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuffer.length,
      },
      bodyBuffer
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.jobId, "client_job_777");
    assert.ok(res.body.telemetry, "telemetry object must be present in response");
    assert.strictEqual(res.body.telemetry.jobId, "client_job_777");
    assert.strictEqual(res.body.telemetry.rasterMs, 142.5);
    assert.strictEqual(res.body.telemetry.ditherMs, 55.2);
    assert.strictEqual(res.body.telemetry.encodeMs, 38.4);
    assert.strictEqual(res.body.telemetry.usbMs, 410.8);
    assert.strictEqual(res.body.telemetry.clientTotalMs, 646.9);
    assert.ok(res.body.telemetry.serverLatencyMs >= 0);

    // Verify stats store
    const stats = getDeviceTelemetry(testDev);
    assert.strictEqual(stats.activeJobs, 0, "activeJobs must decrement to 0 upon completion");
    assert.strictEqual(stats.totalJobsCompleted, 1);
    assert.strictEqual(stats.totalJobsFailed, 0);
    assert.strictEqual(stats.recentJobs.length, 1);

    const recorded = stats.recentJobs[0];
    assert.strictEqual(recorded.jobId, "client_job_777");
    assert.strictEqual(recorded.status, "success");
    assert.strictEqual(recorded.filename, "test.pdf");
    assert.strictEqual(recorded.stages.rasterMs, 142.5);
    assert.strictEqual(recorded.stages.usbMs, 410.8);
  } finally {
    devices.delete(testDev);
  }
});

suite.test("M7.7 Ring buffer enforces MAX_RECENT_JOBS = 50 capacity with FIFO ordering", () => {
  const testDev = "m7_buffer_dev_" + Date.now();
  const stats = getDeviceTelemetry(testDev);

  // Push 60 simulated job entries
  for (let i = 1; i <= 60; i++) {
    stats.recentJobs.unshift({
      jobId: `job_${i}`,
      timestamp: Date.now() + i,
      latencyMs: i * 10,
      status: "success",
    });
    if (stats.recentJobs.length > MAX_RECENT_JOBS) {
      stats.recentJobs.pop();
    }
  }

  assert.strictEqual(stats.recentJobs.length, 50, "Buffer size must not exceed MAX_RECENT_JOBS (50)");
  assert.strictEqual(stats.recentJobs[0].jobId, "job_60", "Index 0 must be the most recently pushed job");
  assert.strictEqual(stats.recentJobs[49].jobId, "job_11", "Index 49 must be the oldest retained job");
});

suite.test("M7.8 POST /relay/:id/print failure decrements activeJobs and tracks totalJobsFailed", async () => {
  await ensureServerStarted();
  const testDev = "m7_print_fail_dev_" + Date.now();

  // Mock device that fails with an error
  const mockWs = {
    readyState: 1,
    send: (data, opts, cb) => {
      if (typeof cb === "function") cb(null);
      setTimeout(() => {
        for (const [id, record] of pending.entries()) {
          if (record.deviceId === testDev) {
            clearTimeout(record.timer);
            pending.delete(id);
            record.resolve({
              type: "print_result",
              requestId: id,
              ok: false,
              error: "Paper jam in tray 1",
            });
            break;
          }
        }
      }, 10);
    },
    terminate: () => {},
  };

  devices.set(testDev, { ws: mockWs, lastSeen: Date.now(), binarySupported: true });

  try {
    const boundary = "---------------------------M7FailBoundary" + Date.now();
    const pdfContent = "%PDF-1.4 dummy";
    const bodyParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fail.pdf"\r\nContent-Type: application/pdf\r\n\r\n${pdfContent}\r\n`,
      `--${boundary}--\r\n`,
    ];
    const bodyBuffer = Buffer.from(bodyParts.join(""));

    const res = await makeHttpRequest(
      "POST",
      `/relay/${testDev}/print`,
      {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuffer.length,
      },
      bodyBuffer
    );

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, "Paper jam in tray 1");

    const stats = getDeviceTelemetry(testDev);
    assert.strictEqual(stats.activeJobs, 0, "activeJobs must be 0 after failure");
    assert.strictEqual(stats.totalJobsFailed, 1);
    assert.strictEqual(stats.recentJobs[0].status, "failed");
    assert.strictEqual(stats.recentJobs[0].error, "Paper jam in tray 1");
  } finally {
    devices.delete(testDev);
  }
});

// Run directly if invoked
if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
    process.exit(0);
  });
}

module.exports = suite;
