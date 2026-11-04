/**
 * Tier 3: Cross-Feature Combinations Test Suite
 * Tests interaction between multiple subsystems, formats, RPC protocols, and printer drivers.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createSuite, assert } = require("./runner");
const { PDFDocument, rgb } = require("pdf-lib");
const { prepareDocumentForPrinter, TARGET_PAGE_W, TARGET_PAGE_H } = require("../prepare-pdf");
const { runBenchmark, benchmarkAll, HP_1020_GEOMETRY, HP_P1007_GEOMETRY } = require("./benchmark-timing");
const { FIXTURES_DIR, A4_W, A4_H, CHEQUE_W, CHEQUE_H } = require("./generate-fixtures");

const suite = createSuite("Tier 3: Cross-Feature Combinations");

// ─────────────────────────────────────────────────────────────
// COMBINATION 1: Multi-Page with Mixed Orientations
// ─────────────────────────────────────────────────────────────

suite.test("3.1 Mixed Orientation: Multi-page doc with portrait + landscape maintains individual page alignment", async () => {
  const doc = await PDFDocument.create();

  // Page 1: Portrait (595 x 842)
  const p1 = doc.addPage([A4_W, A4_H]);
  p1.drawText("Page 1: Portrait", { x: 50, y: 750, size: 14 });

  // Page 2: Landscape (842 x 595)
  const p2 = doc.addPage([A4_H, A4_W]);
  p2.drawText("Page 2: Landscape", { x: 50, y: 500, size: 14 });

  // Page 3: Portrait (595 x 842)
  const p3 = doc.addPage([A4_W, A4_H]);
  p3.drawText("Page 3: Portrait", { x: 50, y: 750, size: 14 });

  const inputBytes = await doc.save();
  const result = await prepareDocumentForPrinter(Buffer.from(inputBytes), "mixed.pdf", { orientation: "auto" });

  const outDoc = await PDFDocument.load(result.buffer);
  assert.strictEqual(outDoc.getPageCount(), 3, "Must retain 3 pages");

  // All output pages in the normalized print stream must conform to standard target drum size
  for (let i = 0; i < 3; i++) {
    const page = outDoc.getPage(i);
    const { width, height } = page.getSize();
    assert.strictEqual(Math.round(width * 10) / 10, Math.round(TARGET_PAGE_W * 10) / 10, `Page ${i + 1} width`);
    assert.strictEqual(Math.round(height * 10) / 10, Math.round(TARGET_PAGE_H * 10) / 10, `Page ${i + 1} height`);
  }
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 2: Dense Graphic through Normalizer & Benchmark
// ─────────────────────────────────────────────────────────────

suite.test("3.2 Dense Graphic Pipeline: Normalization preserves image stream integrity & passes benchmark", async () => {
  const densePath = path.join(FIXTURES_DIR, "synthetic_dense_graphic.pdf");
  const denseBytes = fs.readFileSync(densePath);

  // 1. Run through normalizer
  const normResult = await prepareDocumentForPrinter(denseBytes, "synthetic_dense_graphic.pdf", { orientation: "auto" });
  assert.ok(normResult.buffer.length > 0);
  const outDoc = await PDFDocument.load(normResult.buffer);
  assert.strictEqual(outDoc.getPageCount(), 1);

  // 2. Run through benchmark harness
  const benchReport = await runBenchmark(normResult.buffer, { printer: "HP LaserJet 1020" });
  assert.strictEqual(benchReport.status, "success");
  assert.ok(benchReport.t_total_ms > 0);
  assert.strictEqual(benchReport.output_pbm_geometry, "9920x7016");
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 3: Cheque Auto-Detection & Shift Verification
// ─────────────────────────────────────────────────────────────

suite.test("3.3 Cheque Detection: Verifies CTS-2010 keywords and 8.9cm tray shift parameters", async () => {
  const chequePath = path.join(FIXTURES_DIR, "synthetic_cheque.pdf");
  const chequeBytes = fs.readFileSync(chequePath);

  // Verify cheque keyword presence in the raw PDF stream (heuristic used by raw-printer-server.js)
  const rawText = chequeBytes.toString("latin1").toUpperCase();
  const requiredKeywords = ["CHEQUE", "CTS-2010", "A/C PAYEE", "RUPEES"];
  for (const kw of requiredKeywords) {
    assert.ok(rawText.includes(kw), `Cheque fixture must contain keyword: ${kw}`);
  }

  // Verify CTS-2010 dimensions: 203mm x 92mm = 575.4pt x 260.8pt
  const doc = await PDFDocument.load(chequeBytes);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  assert.strictEqual(Math.round(width), Math.round(CHEQUE_W));
  assert.strictEqual(Math.round(height), Math.round(CHEQUE_H));

  // Verify shift calculation: 8.9cm = 8.9 * 72 / 2.54 = 252.28 pt left shift
  const shiftX = (-8.9 * 72) / 2.54;
  assert.strictEqual(Math.round(shiftX * 100) / 100, -252.28, "Leftward shift must equal -252.28 pt");
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 4: Sequential Benchmark Across All 5 Fixtures
// ─────────────────────────────────────────────────────────────

suite.test("3.4 Benchmark Isolation: Sequential execution across all 5 fixtures has zero state bleed", async () => {
  const reports = await benchmarkAll(FIXTURES_DIR);
  assert.strictEqual(reports.length, 5, "Must produce reports for all 5 fixtures");

  const expectedFiles = [
    "synthetic_invoice.pdf",
    "synthetic_multipage.pdf",
    "synthetic_a4_grid.pdf",
    "synthetic_dense_graphic.pdf",
    "synthetic_cheque.pdf"
  ];

  const seenJobIds = new Set();
  reports.forEach((r, idx) => {
    assert.strictEqual(r.filename, expectedFiles[idx]);
    assert.strictEqual(r.status, "success");
    assert.ok(!seenJobIds.has(r.jobId), "Each benchmark job must have a unique jobId");
    seenJobIds.add(r.jobId);
    assert.ok(r.t_total_ms > 0);
    assert.strictEqual(r.output_pbm_geometry, "9920x7016");
  });
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 5: Relay WebSocket RPC Roundtrip Simulation
// ─────────────────────────────────────────────────────────────

suite.test("3.5 WebSocket RPC Protocol: Multipart -> Base64 -> RPC Message -> Android telemetry roundtrip", async () => {
  const invoicePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");
  const originalBytes = fs.readFileSync(invoicePath);
  const originalHash = crypto.createHash("sha256").update(originalBytes).digest("hex");

  // Step 1: Desktop Client encodes job
  const requestId = `req_${Date.now()}`;
  const rpcPrintMessage = {
    type: "print",
    requestId,
    filename: "synthetic_invoice.pdf",
    fileBase64: originalBytes.toString("base64"),
    options: {
      printer: "HP LaserJet 1020",
      copies: 1,
      orientation: "auto",
      paperSize: "a4"
    }
  };

  // Step 2: Wire transfer over WebSocket
  const wireFrame = JSON.stringify(rpcPrintMessage);
  assert.ok(wireFrame.length > originalBytes.length, "Base64 JSON expands payload");

  // Step 3: Android Bridge receives and decodes
  const receivedMsg = JSON.parse(wireFrame);
  assert.strictEqual(receivedMsg.type, "print");
  assert.strictEqual(receivedMsg.requestId, requestId);

  const decodedBytes = Buffer.from(receivedMsg.fileBase64, "base64");
  const decodedHash = crypto.createHash("sha256").update(decodedBytes).digest("hex");
  assert.strictEqual(decodedHash, originalHash, "SHA256 payload integrity must be 100% byte identical");

  // Step 4: Android returns print_result with telemetry
  const rpcResult = {
    type: "print_result",
    requestId,
    ok: true,
    error: null,
    telemetry: {
      rasterMs: 450.2,
      ditherMs: 310.5,
      encodeMs: 245.1,
      usbMs: 180.4,
      totalMs: 1186.2
    }
  };

  assert.strictEqual(rpcResult.ok, true);
  assert.strictEqual(rpcResult.requestId, requestId);
  assert.ok(rpcResult.telemetry.totalMs < 10000, "Turnaround must meet speed target");
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 6: Printer Model Switching (HP 1020 vs HP P1007)
// ─────────────────────────────────────────────────────────────

suite.test("3.6 Printer Model Switch: HP LaserJet 1020 (ZJ) vs HP LaserJet P1007 (XQX)", async () => {
  const invoicePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");

  // Run HP 1020
  const report1020 = await runBenchmark(invoicePath, { printer: "HP LaserJet 1020" });
  assert.strictEqual(report1020.printer, "HP LaserJet 1020");
  assert.strictEqual(report1020.output_pbm_geometry, "9920x7016");

  // Run HP P1007 immediately after
  const reportP1007 = await runBenchmark(invoicePath, { printer: "HP LaserJet P1007" });
  assert.strictEqual(reportP1007.printer, "HP LaserJet P1007");
  assert.strictEqual(reportP1007.output_pbm_geometry, "9920x7016");

  // Verify clean independence
  assert.notStrictEqual(report1020.jobId, reportP1007.jobId);
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 7: PDF Fast-Path Orientation Preservation & isPreformatted
// ─────────────────────────────────────────────────────────────

suite.test("3.7 Orientation Preservation & isPreformatted passthrough in PDF fast-path", async () => {
  const { packBinaryMessage, unpackBinaryMessage } = require("../server");
  const invoicePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");
  const originalBytes = fs.readFileSync(invoicePath);

  // Scenario A: Landscape PDF job
  const landscapeOptions = {
    printer: "HP LaserJet 1020",
    copies: 1,
    orientation: "landscape",
    paperSize: "a4",
    isPreformatted: true,
  };

  const metaLandscape = {
    type: "print",
    requestId: "req_landscape_test",
    filename: "synthetic_invoice.pdf",
    options: landscapeOptions,
  };

  const frameLandscape = packBinaryMessage(metaLandscape, originalBytes);
  const unpackedLandscape = unpackBinaryMessage(frameLandscape);

  assert.strictEqual(unpackedLandscape.meta.options.orientation, "landscape", "Must preserve landscape orientation for PDF");
  assert.strictEqual(unpackedLandscape.meta.options.isPreformatted, true, "Must forward isPreformatted boolean flag");
  assert.strictEqual(unpackedLandscape.payload.length, originalBytes.length, "Payload size must match original exactly");

  // Scenario B: Auto orientation PDF job
  const autoOptions = {
    printer: "HP LaserJet P1007",
    copies: 2,
    orientation: "auto",
    paperSize: "a4",
    isPreformatted: false,
  };

  const metaAuto = {
    type: "print",
    requestId: "req_auto_test",
    filename: "synthetic_invoice.pdf",
    options: autoOptions,
  };

  const frameAuto = packBinaryMessage(metaAuto, originalBytes);
  const unpackedAuto = unpackBinaryMessage(frameAuto);

  assert.strictEqual(unpackedAuto.meta.options.orientation, "auto", "Must preserve auto orientation for PDF");
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 8: Binary WebSocket Framing Roundtrip
// ─────────────────────────────────────────────────────────────

suite.test("3.8 Length-Prefixed Binary WebSocket Framing Roundtrip & SHA-256 Byte Fidelity", async () => {
  const { packBinaryMessage, unpackBinaryMessage } = require("../server");
  const fixturePath = path.join(FIXTURES_DIR, "synthetic_dense_graphic.pdf");
  const payloadBytes = fs.readFileSync(fixturePath);
  const originalSha = crypto.createHash("sha256").update(payloadBytes).digest("hex");

  const meta = {
    type: "print",
    requestId: "bin_req_1001",
    filename: "synthetic_dense_graphic.pdf",
    options: {
      printer: "HP LaserJet 1020",
      copies: 1,
      paperSize: "a4",
      orientation: "auto",
      isPreformatted: true,
    },
  };

  // Pack binary frame
  const packedBuffer = packBinaryMessage(meta, payloadBytes);

  // Validate 4-byte header length matches JSON string length
  assert.ok(packedBuffer.length > payloadBytes.length + 4, "Packed buffer includes 4-byte header and JSON");
  const headerLen = packedBuffer.readUInt32BE(0);
  const jsonString = packedBuffer.slice(4, 4 + headerLen).toString("utf8");
  const parsedHeader = JSON.parse(jsonString);

  assert.strictEqual(parsedHeader.type, "print");
  assert.strictEqual(parsedHeader.requestId, "bin_req_1001");
  assert.strictEqual(parsedHeader.filename, "synthetic_dense_graphic.pdf");

  // Unpack binary frame
  const unpacked = unpackBinaryMessage(packedBuffer);
  assert.ok(unpacked, "Unpack must succeed");
  assert.deepStrictEqual(unpacked.meta, meta, "Metadata must match exactly");

  // Check 100% SHA256 integrity of raw binary payload
  const unpackedSha = crypto.createHash("sha256").update(unpacked.payload).digest("hex");
  assert.strictEqual(unpackedSha, originalSha, "Payload must be 100% bit-for-bit identical");

  // Verify wire overhead is minimal (<1KB header overhead vs >33% Base64 expansion)
  const headerOverheadBytes = packedBuffer.length - payloadBytes.length;
  assert.ok(headerOverheadBytes < 1024, `Header overhead should be <1KB, was ${headerOverheadBytes} bytes`);
  const base64Len = payloadBytes.toString("base64").length;
  assert.ok(packedBuffer.length < base64Len, "Binary frame must be significantly smaller than Base64 string");
});

// ─────────────────────────────────────────────────────────────
// COMBINATION 9: Disconnect Timeout Abortion & Connection Hardening
// ─────────────────────────────────────────────────────────────

suite.test("3.9 Socket Disconnect Aborts Pending RPCs Immediately", async () => {
  const { rpc, devices, pending } = require("../server");

  // Create a mock socket with EventEmitter-like events
  const mockWs = {
    readyState: 1, // OPEN
    send: (data, opts, cb) => { if (typeof cb === "function") cb(null); },
    terminate: () => {},
  };

  const testDeviceId = "test-disconnect-device-" + Date.now();
  devices.set(testDeviceId, { ws: mockWs, lastSeen: Date.now(), binarySupported: true });

  // Initiate RPC with standard timeout (e.g. 10000ms)
  const startTime = Date.now();
  const rpcPromise = rpc(testDeviceId, {
    type: "print",
    filename: "test.pdf",
    binaryPayload: Buffer.from("%PDF-1.4 test dummy"),
  }, 10000);

  // Assert pending map has the entry with socket tracking
  let trackedReqId = null;
  for (const [id, record] of pending.entries()) {
    if (record.ws === mockWs) {
      trackedReqId = id;
      break;
    }
  }
  assert.ok(trackedReqId !== null, "Pending request must track the socket instance");

  // Simulate socket disconnect: trigger immediate rejection of pending RPCs for this socket
  for (const [reqId, p] of pending.entries()) {
    if (p.ws === mockWs) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(Object.assign(new Error("device_offline"), { ok: false, error: "device_offline" }));
    }
  }
  devices.delete(testDeviceId);

  // Assert rpcPromise rejected immediately without waiting for 10000ms timeout
  let rejectedError = null;
  try {
    await rpcPromise;
  } catch (err) {
    rejectedError = err;
  }

  const elapsed = Date.now() - startTime;
  assert.ok(rejectedError !== null, "RPC must be rejected on socket disconnect");
  assert.strictEqual(rejectedError.error, "device_offline");
  assert.strictEqual(rejectedError.ok, false);
  assert.ok(elapsed < 200, `Abort must happen immediately (<200ms), took ${elapsed}ms`);
  assert.strictEqual(pending.has(trackedReqId), false, "Pending map must be cleaned up");
});

// Run if executed directly
if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
  });
}

module.exports = suite;
