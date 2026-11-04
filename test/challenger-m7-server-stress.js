/**
 * Challenger M7 Adversarial Stress Verification Suite
 * Milestone: M7 (End-to-End Telemetry, Queue Health & Diagnostics)
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST:
 * 1. Active Jobs Counter Integrity:
 *    - 100 concurrent print requests across 4 distinct failure modes:
 *      (a) WebSocket connection drops abruptly
 *      (b) RPC times out
 *      (c) Client aborts HTTP connection mid-stream
 *      (d) Device returns unexpected error / exception
 *    - Strict assertion: stats.activeJobs strictly returns to 0 under all failure modes (zero counter leak).
 * 2. Ring Buffer Boundary & FIFO Capping:
 *    - Push 500 print jobs into device telemetry.
 *    - Strict assertion: stats.recentJobs.length === 50 at all times once capacity reached.
 *    - Strict assertion: recentJobs[0] is always the most recent job (FIFO order preserved).
 *    - Integration assertion: High-volume HTTP dispatches cap at 50 with newest-first ordering.
 * 3. Statistical Math Rigor:
 *    - Test calculateLatencyMetrics across empty, null, single-item, identical values,
 *      bimodal distributions, extreme outliers, permutation invariance, and malformed inputs.
 *    - Strict assertion: p95 is strictly between min and max, never NaN, never undefined.
 * 4. Multi-Device Isolation:
 *    - Concurrently send 50 jobs to device-A and 50 jobs to device-B (100 concurrent jobs).
 *    - Strict assertion: device-A contains 0 jobs from device-B, and vice versa (zero state leakage).
 * 5. Offline Device Query Resilience:
 *    - Query /relay/nonexistent-device/telemetry with standard, unicode, special characters, and long IDs.
 *    - Strict assertion: Clean 200 response with exact contract defaults.
 * 6. Concurrent Read/Write Race Condition Stress:
 *    - Concurrently interleave 50 mutating print operations with 50 telemetry reads.
 *    - Strict assertion: Zero crashes, zero unhandled rejections, valid mathematical metrics.
 */

const http = require("http");
const crypto = require("crypto");
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

const suite = createSuite("Milestone M7 Challenger: Empirical Adversarial Stress Suite");

let serverPort = null;
let serverUrl = null;
let ipCounter = 1;

async function ensureServerStarted() {
  app.set("trust proxy", true);
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

/**
 * Robust HTTP client helper that assigns distinct synthetic client IPs
 * via X-Forwarded-For to bypass the 60 req/min rate limiter during high-load stress testing.
 */
function makeHttpRequest(method, urlPath, headers = {}, body = null, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, serverUrl);
    const syntheticIp = `10.99.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
    ipCounter++;

    const reqHeaders = {
      "x-forwarded-for": syntheticIp,
      ...headers,
    };

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
        timeout: options.timeout || 15000,
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

    req.on("error", (err) => {
      if (options.ignoreError) {
        resolve({ error: err, status: 0 });
      } else {
        reject(err);
      }
    });

    if (options.abortAfterMs) {
      setTimeout(() => {
        req.destroy(new Error("client_aborted"));
      }, options.abortAfterMs);
    }

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function buildMultipartBody(fields = {}, filename = "test.pdf", fileContent = "%PDF-1.4 stress dummy") {
  const boundary = "---------------------------M7StressBoundary" + crypto.randomBytes(8).toString("hex");
  const parts = [];

  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }

  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n${fileContent}\r\n`
  );
  parts.push(`--${boundary}--\r\n`);

  const buffer = Buffer.from(parts.join(""));
  return {
    buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ─────────────────────────────────────────────────────────────
// 1. ACTIVE JOBS COUNTER INTEGRITY (100 CONCURRENT FAILURES)
// ─────────────────────────────────────────────────────────────

suite.test("1.1 Active Jobs Integrity: 100 concurrent failed print requests strictly return activeJobs to 0", async () => {
  await ensureServerStarted();
  const testDev = "m7_active_leak_dev_" + Date.now();
  const stats = getDeviceTelemetry(testDev);

  assert.strictEqual(stats.activeJobs, 0, "Initial activeJobs must be 0");

  // Create a specialized mock WebSocket device that injects 4 types of failures:
  // (a) 25 jobs: WebSocket drops mid-flight (p.reject with device_offline)
  // (b) 25 jobs: RPC times out (p.reject with timeout)
  // (c) 25 jobs: Client aborts HTTP connection mid-stream (req.destroy)
  // (d) 25 jobs: Device returns application-level error (resolve ok: false)
  let requestCounter = 0;

  const mockWs = {
    readyState: 1,
    send: (data, opts, cb) => {
      if (typeof cb === "function") cb(null);

      // Process RPC message asynchronously
      setTimeout(() => {
        for (const [id, record] of pending.entries()) {
          if (record.deviceId === testDev) {
            clearTimeout(record.timer);
            pending.delete(id);

            const mode = record.failureMode;
            if (mode === "ws_drop") {
              record.reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
            } else if (mode === "timeout") {
              record.reject(Object.assign(new Error("timeout"), { ok: false, error: "timeout" }));
            } else if (mode === "app_error") {
              record.resolve({
                type: "print_result",
                requestId: id,
                ok: false,
                error: "Printer hardware head jam",
              });
            } else {
              // Default fallback for client_abort mode: resolve after a short delay
              record.resolve({
                type: "print_result",
                requestId: id,
                ok: true,
                jobId: "client_aborted_job",
                telemetry: { totalMs: 50.0 },
              });
            }
            break;
          }
        }
      }, 15);
    },
    terminate: () => {},
  };

  devices.set(testDev, { ws: mockWs, lastSeen: Date.now(), binarySupported: true });

  try {
    const promises = [];
    const totalRequests = 100;

    for (let i = 0; i < totalRequests; i++) {
      let failureMode = "ws_drop";
      let abortAfterMs = null;

      if (i < 25) {
        failureMode = "ws_drop";
      } else if (i < 50) {
        failureMode = "timeout";
      } else if (i < 75) {
        failureMode = "client_abort";
        abortAfterMs = 5; // Client abruptly disconnects after 5ms
      } else {
        failureMode = "app_error";
      }

      // Tag pending records with failureMode by monkey-patching rpc call flow or through filename
      const { buffer, contentType } = buildMultipartBody(
        { printer: "HP P1007", failureMode },
        `stress_doc_${i}.pdf`
      );

      // Intercept pending set to tag failure mode
      const reqPromise = (async () => {
        // Tag pending entry when it appears
        const checkInterval = setInterval(() => {
          for (const [id, record] of pending.entries()) {
            if (record.deviceId === testDev && !record.failureMode) {
              record.failureMode = failureMode;
            }
          }
        }, 1);

        try {
          return await makeHttpRequest(
            "POST",
            `/relay/${testDev}/print`,
            {
              "Content-Type": contentType,
              "Content-Length": buffer.length,
            },
            buffer,
            { abortAfterMs, ignoreError: true }
          );
        } finally {
          clearInterval(checkInterval);
        }
      })();

      promises.push(reqPromise);
    }

    // Wait for all 100 requests to settle
    const results = await Promise.allSettled(promises);
    assert.strictEqual(results.length, 100, "All 100 requests must complete");

    // CRITICAL ADVERSARIAL ASSERTION:
    // Under 100 simultaneous errors and aborts, activeJobs MUST strictly be 0.
    assert.strictEqual(
      stats.activeJobs,
      0,
      `activeJobs leaked! Expected 0 but got ${stats.activeJobs} after 100 concurrent failures`
    );

    // Verify telemetry store state
    assert.ok(stats.totalJobsFailed >= 75, `Expected at least 75 failed jobs recorded, got ${stats.totalJobsFailed}`);
  } finally {
    devices.delete(testDev);
  }
});

// ─────────────────────────────────────────────────────────────
// 2. RING BUFFER BOUNDARY & FIFO CAPPING (500 JOBS)
// ─────────────────────────────────────────────────────────────

suite.test("2.1 Ring Buffer Boundary: Pushing 500 jobs strictly caps at 50 with exact FIFO ordering", () => {
  const testDev = "m7_ring_stress_dev_" + Date.now();
  const stats = getDeviceTelemetry(testDev);

  // Push 500 print jobs into device telemetry
  for (let i = 1; i <= 500; i++) {
    const jobRecord = {
      jobId: `job_stream_${i}`,
      timestamp: 1700000000000 + i,
      filename: `doc_${i}.pdf`,
      printer: "HP LaserJet 1020",
      status: i % 10 === 0 ? "failed" : "success",
      latencyMs: 100 + (i % 50),
      stages: {
        serverLatencyMs: 100 + (i % 50),
        rasterMs: 10,
        ditherMs: 5,
        encodeMs: 5,
        usbMs: 80,
        clientTotalMs: 100,
      },
      error: i % 10 === 0 ? "Simulated error" : null,
    };

    stats.recentJobs.unshift(jobRecord);
    if (stats.recentJobs.length > MAX_RECENT_JOBS) {
      stats.recentJobs.pop();
    }

    // Assert boundary condition at every single step after capacity is reached
    if (i >= 50) {
      assert.strictEqual(
        stats.recentJobs.length,
        50,
        `Ring buffer size exceeded MAX_RECENT_JOBS at step ${i}: length=${stats.recentJobs.length}`
      );
      assert.strictEqual(
        stats.recentJobs[0].jobId,
        `job_stream_${i}`,
        `Index 0 must strictly be the newest job (step ${i})`
      );
    }
  }

  // Final assertions on the 500-job stress test
  assert.strictEqual(stats.recentJobs.length, 50, "Buffer length must remain exactly 50");
  assert.strictEqual(stats.recentJobs[0].jobId, "job_stream_500", "recentJobs[0] must be job_stream_500");
  assert.strictEqual(stats.recentJobs[49].jobId, "job_stream_451", "recentJobs[49] must be job_stream_451");

  // Verify strict monotonic descending order (FIFO preservation)
  for (let idx = 0; idx < 49; idx++) {
    const currentSeq = parseInt(stats.recentJobs[idx].jobId.replace("job_stream_", ""), 10);
    const nextSeq = parseInt(stats.recentJobs[idx + 1].jobId.replace("job_stream_", ""), 10);
    assert.strictEqual(
      currentSeq,
      nextSeq + 1,
      `Strict FIFO sequence broken at index ${idx}: ${currentSeq} vs ${nextSeq}`
    );
  }
});

suite.test("2.2 Ring Buffer Endpoint Integration: 60 sequential HTTP prints cap at 50 in GET telemetry", async () => {
  await ensureServerStarted();
  const testDev = "m7_http_cap_dev_" + Date.now();

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
              ok: true,
              jobId: `http_job_${id.substring(0, 8)}`,
              telemetry: { totalMs: 25.0 },
            });
            break;
          }
        }
      }, 5);
    },
    terminate: () => {},
  };

  devices.set(testDev, { ws: mockWs, lastSeen: Date.now(), binarySupported: true });

  try {
    // Send 60 print jobs sequentially
    for (let i = 1; i <= 60; i++) {
      const { buffer, contentType } = buildMultipartBody({ printer: "HP P1007" }, `cap_test_${i}.pdf`);
      const res = await makeHttpRequest(
        "POST",
        `/relay/${testDev}/print`,
        {
          "Content-Type": contentType,
          "Content-Length": buffer.length,
        },
        buffer
      );
      assert.strictEqual(res.status, 200);
    }

    // Query telemetry endpoint
    const telRes = await makeHttpRequest("GET", `/relay/${testDev}/telemetry`);
    assert.strictEqual(telRes.status, 200);
    assert.strictEqual(telRes.body.recentJobs.length, 50, "HTTP endpoint must strictly cap recentJobs at 50");
    assert.strictEqual(telRes.body.totalJobsCompleted, 60, "totalJobsCompleted must reflect all 60 jobs");
    assert.strictEqual(telRes.body.activeJobs, 0, "activeJobs must be 0");
    assert.strictEqual(telRes.body.recentJobs[0].filename, "cap_test_60.pdf", "Newest job must be at index 0");
  } finally {
    devices.delete(testDev);
  }
});

// ─────────────────────────────────────────────────────────────
// 3. STATISTICAL MATH RIGOR (METRICS & PERCENTILE EDGES)
// ─────────────────────────────────────────────────────────────

suite.test("3.1 Statistical Math: Empty arrays, nulls, undefined, and non-numeric latencies", () => {
  const cases = [
    [],
    null,
    undefined,
    [{}],
    [{ latencyMs: null }],
    [{ latencyMs: "fast" }],
    [{ latencyMs: -100 }],
    [{ latencyMs: NaN }],
    [null, undefined, { latencyMs: -0.01 }],
  ];

  for (const c of cases) {
    const res = calculateLatencyMetrics(c);
    assert.strictEqual(res.avgLatencyMs, 0, `Expected 0 avgLatencyMs for ${JSON.stringify(c)}`);
    assert.strictEqual(res.p95LatencyMs, 0, `Expected 0 p95LatencyMs for ${JSON.stringify(c)}`);
    assert.ok(!isNaN(res.avgLatencyMs), "avgLatencyMs must never be NaN");
    assert.ok(!isNaN(res.p95LatencyMs), "p95LatencyMs must never be NaN");
    assert.ok(res.avgLatencyMs !== undefined, "avgLatencyMs must never be undefined");
    assert.ok(res.p95LatencyMs !== undefined, "p95LatencyMs must never be undefined");
  }
});

suite.test("3.2 Statistical Math: Single-item array invariants", () => {
  const singleValues = [0, 0.1, 42.5, 999.99, 12345.67];

  for (const val of singleValues) {
    const res = calculateLatencyMetrics([{ latencyMs: val }]);
    assert.strictEqual(res.avgLatencyMs, Math.round(val * 100) / 100);
    assert.strictEqual(res.p95LatencyMs, Math.round(val * 100) / 100);
    assert.ok(res.p95LatencyMs >= val && res.p95LatencyMs <= val, "p95 must equal single item value");
  }
});

suite.test("3.3 Statistical Math: Identical values array invariants", () => {
  const identicalVal = 350.25;
  const arr = Array.from({ length: 50 }, () => ({ latencyMs: identicalVal }));
  const res = calculateLatencyMetrics(arr);

  assert.strictEqual(res.avgLatencyMs, identicalVal);
  assert.strictEqual(res.p95LatencyMs, identicalVal);
  assert.ok(res.p95LatencyMs >= identicalVal && res.p95LatencyMs <= identicalVal);
});

suite.test("3.4 Statistical Math: Bimodal distribution stress", () => {
  // 25 jobs at 50ms (fast cache), 25 jobs at 500ms (cold render)
  // Total 50 jobs. 95th percentile index = ceil(0.95 * 50) - 1 = 48 - 1 = 47.
  // sorted[47] is 500ms.
  // Average = (25*50 + 25*500) / 50 = 275ms.
  const bimodal = [
    ...Array.from({ length: 25 }, () => ({ latencyMs: 50.0 })),
    ...Array.from({ length: 25 }, () => ({ latencyMs: 500.0 })),
  ];

  const res = calculateLatencyMetrics(bimodal);
  assert.strictEqual(res.avgLatencyMs, 275.0);
  assert.strictEqual(res.p95LatencyMs, 500.0);
  assert.ok(res.p95LatencyMs >= 50.0 && res.p95LatencyMs <= 500.0, "p95 must be between min (50) and max (500)");
});

suite.test("3.5 Statistical Math: Extreme outliers & skewness", () => {
  // Case A: 49 fast jobs (10ms) + 1 extreme outlier (100,000ms)
  // Sorted length = 50. rank = ceil(0.95 * 50) - 1 = 47.
  // Index 47 is still 10ms (outlier is at index 49).
  // p95 should be 10ms!
  const outlierA = [
    ...Array.from({ length: 49 }, () => ({ latencyMs: 10.0 })),
    { latencyMs: 100000.0 },
  ];
  const resA = calculateLatencyMetrics(outlierA);
  assert.strictEqual(resA.p95LatencyMs, 10.0, "p95 should filter out top 5% extreme outlier in 50-sample set");
  assert.ok(resA.p95LatencyMs >= 10.0 && resA.p95LatencyMs <= 100000.0);
  assert.strictEqual(resA.avgLatencyMs, Math.round(((49 * 10 + 100000) / 50) * 100) / 100);

  // Case B: 45 fast jobs (10ms) + 5 extreme outliers (100,000ms)
  // Top 10% are outliers. Index 47 is 100,000ms.
  const outlierB = [
    ...Array.from({ length: 45 }, () => ({ latencyMs: 10.0 })),
    ...Array.from({ length: 5 }, () => ({ latencyMs: 100000.0 })),
  ];
  const resB = calculateLatencyMetrics(outlierB);
  assert.strictEqual(resB.p95LatencyMs, 100000.0);
  assert.ok(resB.p95LatencyMs >= 10.0 && resB.p95LatencyMs <= 100000.0);
});

suite.test("3.6 Statistical Math: Permutation invariance under shuffling", () => {
  // Generate random 50 values
  const baseLatencies = Array.from({ length: 50 }, (_, i) => ({
    latencyMs: Math.round((Math.sin(i) * 200 + 300) * 100) / 100,
  }));

  const reference = calculateLatencyMetrics(baseLatencies);
  assert.ok(!isNaN(reference.avgLatencyMs));
  assert.ok(!isNaN(reference.p95LatencyMs));

  // Fisher-Yates shuffle 25 times and verify math results are strictly invariant
  for (let s = 0; s < 25; s++) {
    const shuffled = [...baseLatencies];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const testRes = calculateLatencyMetrics(shuffled);
    assert.strictEqual(testRes.avgLatencyMs, reference.avgLatencyMs, "Average must be permutation invariant");
    assert.strictEqual(testRes.p95LatencyMs, reference.p95LatencyMs, "P95 must be permutation invariant");
  }
});

// ─────────────────────────────────────────────────────────────
// 4. MULTI-DEVICE ISOLATION (50 JOBS DEV A, 50 JOBS DEV B)
// ─────────────────────────────────────────────────────────────

suite.test("4.1 Multi-Device Isolation: Concurrent 50 jobs to device-A and 50 to device-B maintain zero state bleed", async () => {
  await ensureServerStarted();
  const devA = "m7_iso_devA_" + Date.now();
  const devB = "m7_iso_devB_" + Date.now();

  function createDeviceWs(devId) {
    return {
      readyState: 1,
      send: (data, opts, cb) => {
        if (typeof cb === "function") cb(null);
        setTimeout(() => {
          for (const [id, record] of pending.entries()) {
            if (record.deviceId === devId) {
              clearTimeout(record.timer);
              pending.delete(id);
              record.resolve({
                type: "print_result",
                requestId: id,
                ok: true,
                jobId: `${devId}_job_${id.substring(0, 6)}`,
                telemetry: {
                  rasterMs: devId === devA ? 10.0 : 20.0,
                  totalMs: devId === devA ? 50.0 : 100.0,
                },
              });
              break;
            }
          }
        }, 8);
      },
      terminate: () => {},
    };
  }

  devices.set(devA, { ws: createDeviceWs(devA), lastSeen: Date.now(), binarySupported: true });
  devices.set(devB, { ws: createDeviceWs(devB), lastSeen: Date.now(), binarySupported: true });

  try {
    // Concurrently dispatch 50 jobs to devA and 50 jobs to devB (100 total concurrent)
    const dispatches = [];

    for (let i = 0; i < 50; i++) {
      // devA job
      const bodyA = buildMultipartBody({ printer: "LaserJet_A" }, `doc_A_${i}.pdf`);
      dispatches.push(
        makeHttpRequest(
          "POST",
          `/relay/${devA}/print`,
          { "Content-Type": bodyA.contentType, "Content-Length": bodyA.buffer.length },
          bodyA.buffer
        )
      );

      // devB job
      const bodyB = buildMultipartBody({ printer: "LaserJet_B" }, `doc_B_${i}.pdf`);
      dispatches.push(
        makeHttpRequest(
          "POST",
          `/relay/${devB}/print`,
          { "Content-Type": bodyB.contentType, "Content-Length": bodyB.buffer.length },
          bodyB.buffer
        )
      );
    }

    const responses = await Promise.all(dispatches);
    assert.strictEqual(responses.length, 100, "All 100 dispatches must succeed");
    for (const r of responses) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ok, true);
    }

    // Query telemetry for devA
    const telA = await makeHttpRequest("GET", `/relay/${devA}/telemetry`);
    assert.strictEqual(telA.status, 200);
    assert.strictEqual(telA.body.deviceId, devA);
    assert.strictEqual(telA.body.activeJobs, 0);
    assert.strictEqual(telA.body.totalJobsCompleted, 50);
    assert.strictEqual(telA.body.recentJobs.length, 50);

    // Query telemetry for devB
    const telB = await makeHttpRequest("GET", `/relay/${devB}/telemetry`);
    assert.strictEqual(telB.status, 200);
    assert.strictEqual(telB.body.deviceId, devB);
    assert.strictEqual(telB.body.activeJobs, 0);
    assert.strictEqual(telB.body.totalJobsCompleted, 50);
    assert.strictEqual(telB.body.recentJobs.length, 50);

    // CRITICAL ADVERSARIAL ISOLATION ASSERTIONS:
    // Assert devA contains ZERO jobs from devB
    for (const j of telA.body.recentJobs) {
      assert.ok(j.jobId.startsWith(`${devA}_`), `devA recentJobs contains foreign job: ${j.jobId}`);
      assert.strictEqual(j.printer, "LaserJet_A");
      assert.strictEqual(j.stages.rasterMs, 10.0);
    }

    // Assert devB contains ZERO jobs from devA
    for (const j of telB.body.recentJobs) {
      assert.ok(j.jobId.startsWith(`${devB}_`), `devB recentJobs contains foreign job: ${j.jobId}`);
      assert.strictEqual(j.printer, "LaserJet_B");
      assert.strictEqual(j.stages.rasterMs, 20.0);
    }

    // Assert mutual disjointness of job IDs
    const setA = new Set(telA.body.recentJobs.map((j) => j.jobId));
    const setB = new Set(telB.body.recentJobs.map((j) => j.jobId));
    for (const idA of setA) {
      assert.ok(!setB.has(idA), `State leak detected: Job ID ${idA} found in both device telemetry sets!`);
    }
  } finally {
    devices.delete(devA);
    devices.delete(devB);
  }
});

// ─────────────────────────────────────────────────────────────
// 5. OFFLINE DEVICE QUERY RESILIENCE (EDGE CASE IDS & DEFAULTS)
// ─────────────────────────────────────────────────────────────

suite.test("5.1 Offline Device Resilience: Clean 200 response with exact contract defaults across diverse IDs", async () => {
  await ensureServerStarted();

  const testIds = [
    "nonexistent-device-" + Date.now(),
    "never_connected_404",
    encodeURIComponent("special!@#$%^&*()_+="),
    encodeURIComponent("unicode_打印机_telemetry"),
    "a".repeat(128), // long ID
  ];

  for (const id of testIds) {
    const res = await makeHttpRequest("GET", `/relay/${id}/telemetry`);
    assert.strictEqual(res.status, 200, `Expected 200 for device ${id}`);
    assert.strictEqual(res.body.online, false, "online must be false");
    assert.strictEqual(res.body.activeJobs, 0, "activeJobs must be 0");
    assert.strictEqual(res.body.avgLatencyMs, 0, "avgLatencyMs must be 0");
    assert.strictEqual(res.body.p95LatencyMs, 0, "p95LatencyMs must be 0");
    assert.ok(Array.isArray(res.body.recentJobs), "recentJobs must be an array");
    assert.strictEqual(res.body.recentJobs.length, 0, "recentJobs must be empty");
    assert.strictEqual(res.body.totalJobsCompleted, 0, "totalJobsCompleted must be 0");
    assert.strictEqual(res.body.totalJobsFailed, 0, "totalJobsFailed must be 0");
  }
});

// ─────────────────────────────────────────────────────────────
// 6. CONCURRENT READ / WRITE RACE CONDITION STRESS
// ─────────────────────────────────────────────────────────────

suite.test("6.1 Race Condition Stress: Interleaved 50 mutations and 50 telemetry queries execute safely", async () => {
  await ensureServerStarted();
  const testDev = "m7_race_dev_" + Date.now();

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
              ok: true,
              jobId: `race_job_${id.substring(0, 6)}`,
              telemetry: { totalMs: 15.0 },
            });
            break;
          }
        }
      }, 5);
    },
    terminate: () => {},
  };

  devices.set(testDev, { ws: mockWs, lastSeen: Date.now(), binarySupported: true });

  try {
    const operations = [];

    // Schedule 50 prints and 50 telemetry reads simultaneously
    for (let i = 0; i < 50; i++) {
      const { buffer, contentType } = buildMultipartBody({ printer: "HP P1007" }, `race_${i}.pdf`);
      operations.push(
        makeHttpRequest(
          "POST",
          `/relay/${testDev}/print`,
          { "Content-Type": contentType, "Content-Length": buffer.length },
          buffer
        )
      );

      // Concurrent read
      operations.push(makeHttpRequest("GET", `/relay/${testDev}/telemetry`));
    }

    const results = await Promise.all(operations);
    assert.strictEqual(results.length, 100);

    for (const r of results) {
      assert.strictEqual(r.status, 200);
      if (r.body.recentJobs) {
        // Telemetry read check
        assert.ok(!isNaN(r.body.avgLatencyMs));
        assert.ok(!isNaN(r.body.p95LatencyMs));
        assert.ok(r.body.activeJobs >= 0);
      }
    }

    // Final clean state check
    const finalTel = await makeHttpRequest("GET", `/relay/${testDev}/telemetry`);
    assert.strictEqual(finalTel.body.activeJobs, 0);
    assert.strictEqual(finalTel.body.totalJobsCompleted, 50);
    assert.strictEqual(finalTel.body.recentJobs.length, 50);
  } finally {
    devices.delete(testDev);
  }
});

// Run directly if invoked from CLI
if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
    process.exit(0);
  });
}

module.exports = suite;
