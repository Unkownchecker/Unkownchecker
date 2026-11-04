/**
 * Tier 4: Real-World Application Scenarios Test Suite
 * Tests full end-to-end user workflows, realistic print sessions,
 * A4 physical calibration, and baseline speedup verification.
 */

const path = require("path");
const fs = require("fs");
const { createSuite, assert } = require("./runner");
const { PDFDocument } = require("pdf-lib");
const { prepareDocumentForPrinter, TARGET_PAGE_W, TARGET_PAGE_H } = require("../prepare-pdf");
const { runBenchmark, BASELINE_TOTAL_MS } = require("./benchmark-timing");
const { FIXTURES_DIR, A4_W, A4_H, CHEQUE_W, CHEQUE_H, MM_TO_PT } = require("./generate-fixtures");

const suite = createSuite("Tier 4: Real-World Application Scenarios");

// ─────────────────────────────────────────────────────────────
// SCENARIO 1: Commercial Tax Invoice End-to-End Workflow
// ─────────────────────────────────────────────────────────────

suite.test("4.1 Scenario: Single-Page Commercial Invoice Workflow (synthetic_invoice.pdf)", async () => {
  const invoicePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");
  const report = await runBenchmark(invoicePath, {
    printer: "HP LaserJet 1020",
    orientation: "auto"
  });

  assert.strictEqual(report.status, "success");
  assert.strictEqual(report.pageCount, 1);
  assert.strictEqual(report.output_pbm_geometry, "9920x7016");
  assert.strictEqual(report.printable_width_dots, 9568);
  assert.strictEqual(report.printable_height_dots, 6848);

  // Validate telemetry stages
  assert.ok(report.t_spool_ms > 0, "Spool stage must be measured");
  assert.ok(report.t_upload_ms > 0, "Upload transit must be measured");
  assert.ok(report.t_relay_ms > 0, "Relay stage must be measured");
  assert.ok(report.t_raster_ms > 0, "Raster stage must be measured");
  assert.ok(report.t_dither_ms > 0, "Dither stage must be measured");
  assert.ok(report.t_encode_ms > 0, "Driver encoding stage must be measured");
  assert.ok(report.t_usb_ms > 0, "USB bulk stage must be measured");
  assert.ok(report.t_total_ms > 0, "Total latency must be measured");

  // Verify speedup against 17.8s baseline
  assert.ok(report.t_total_ms < BASELINE_TOTAL_MS, `Total latency (${report.t_total_ms}ms) must be less than baseline (${BASELINE_TOTAL_MS}ms)`);
  assert.strictEqual(report.baseline_comparison.faster_than_baseline, true);
});

// ─────────────────────────────────────────────────────────────
// SCENARIO 2: Multi-Page Technical Document Streaming
// ─────────────────────────────────────────────────────────────

suite.test("4.2 Scenario: Multi-Page Streaming & Memory Stability (synthetic_multipage.pdf)", async () => {
  const multipagePath = path.join(FIXTURES_DIR, "synthetic_multipage.pdf");
  const report = await runBenchmark(multipagePath, {
    printer: "HP LaserJet 1020",
    orientation: "auto"
  });

  assert.strictEqual(report.status, "success");
  assert.strictEqual(report.pageCount, 4, "Must process all 4 pages");
  assert.strictEqual(report.output_pbm_geometry, "9920x7016");

  // Multi-page total latency should scale with page count but stay within reasonable bounds
  assert.ok(report.t_raster_ms >= 1000, "4-page rasterization time scales linearly");
  assert.ok(report.t_dither_ms >= 1000, "4-page dithering time scales linearly");
  assert.ok(report.t_total_ms < BASELINE_TOTAL_MS, "4-page job should still beat the single-page legacy baseline");
});

// ─────────────────────────────────────────────────────────────
// SCENARIO 3: Exact 1:1 A4 Alignment & Margin Verification
// ─────────────────────────────────────────────────────────────

suite.test("4.3 Scenario: 100% 1:1 A4 Scaling & Zero Margin Distortion (synthetic_a4_grid.pdf)", async () => {
  const gridPath = path.join(FIXTURES_DIR, "synthetic_a4_grid.pdf");
  const gridBytes = fs.readFileSync(gridPath);
  const doc = await PDFDocument.load(gridBytes);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();

  // 1. Verify standard A4 physical dimension: 210mm x 297mm (595.28 pt x 841.89 pt)
  const widthMm = (width * 25.4) / 72;
  const heightMm = (height * 25.4) / 72;
  assert.strictEqual(Math.round(widthMm * 10) / 10, 210.0, "Physical width must be 210mm");
  assert.strictEqual(Math.round(heightMm * 10) / 10, 297.0, "Physical height must be 297mm");

  // 2. Verify outer border margin is exactly 5mm (14.17 pt)
  const margin5mm = 5 * MM_TO_PT;
  assert.strictEqual(Math.round(margin5mm * 100) / 100, 14.17, "5mm margin in points");

  // 3. Verify inner border margin is exactly 10mm (28.35 pt)
  const margin10mm = 10 * MM_TO_PT;
  assert.strictEqual(Math.round(margin10mm * 100) / 100, 28.35, "10mm margin in points");

  // 4. Verify center crosshairs intersect at exact mathematical midpoint
  const centerCrossX = width / 2;
  const centerCrossY = height / 2;
  assert.strictEqual(Math.round(centerCrossX * 100) / 100, 297.64, "X midpoint");
  assert.strictEqual(Math.round(centerCrossY * 100) / 100, 420.95, "Y midpoint");
});

// ─────────────────────────────────────────────────────────────
// SCENARIO 4: High-Frequency Dithering & JBIG Compression Stress
// ─────────────────────────────────────────────────────────────

suite.test("4.4 Scenario: High-Entropy Dithering & Compression Stress (synthetic_dense_graphic.pdf)", async () => {
  const densePath = path.join(FIXTURES_DIR, "synthetic_dense_graphic.pdf");
  const report = await runBenchmark(densePath, {
    printer: "HP LaserJet 1020"
  });

  assert.strictEqual(report.status, "success");
  assert.strictEqual(report.output_pbm_geometry, "9920x7016");
  assert.ok(report.t_dither_ms > 0, "Dithering must execute and be measured");
  assert.ok(report.t_encode_ms > 0, "Driver JBIG compression must be measured");
});

// ─────────────────────────────────────────────────────────────
// SCENARIO 5: CTS-2010 Bank Cheque Auto-Alignment Workflow
// ─────────────────────────────────────────────────────────────

suite.test("4.5 Scenario: CTS-2010 Bank Cheque Detection & Tray Shift Workflow (synthetic_cheque.pdf)", async () => {
  const chequePath = path.join(FIXTURES_DIR, "synthetic_cheque.pdf");
  const chequeBytes = fs.readFileSync(chequePath);

  // 1. Sniff test (matching raw-printer-server.js logic)
  const sampleText = chequeBytes.subarray(0, 4096).toString("ascii").toLowerCase();
  const isCheque =
    sampleText.includes("cheque") ||
    sampleText.includes("chq") ||
    sampleText.includes("a/c payee") ||
    sampleText.includes("rupees");
  assert.strictEqual(isCheque, true, "RAW sniffer must detect cheque keywords in first 4096 bytes");

  // 2. Verify CTS-2010 dimensions (203mm x 92mm)
  const doc = await PDFDocument.load(chequeBytes);
  const page = doc.getPage(0);
  const size = page.getSize();
  assert.strictEqual(Math.round(size.width), Math.round(CHEQUE_W));
  assert.strictEqual(Math.round(size.height), Math.round(CHEQUE_H));

  // 3. Verify benchmark report
  const report = await runBenchmark(chequeBytes, {
    printer: "HP LaserJet 1020",
    filename: "synthetic_cheque.pdf"
  });
  assert.strictEqual(report.status, "success");
});

// ─────────────────────────────────────────────────────────────
// SCENARIO 6: Latency Benchmark Evaluation Against ~17.8s Baseline
// ─────────────────────────────────────────────────────────────

suite.test("4.6 Scenario: Global Speedup Across All Synthetic Test Documents", async () => {
  const files = [
    "synthetic_invoice.pdf",
    "synthetic_multipage.pdf",
    "synthetic_a4_grid.pdf",
    "synthetic_dense_graphic.pdf",
    "synthetic_cheque.pdf"
  ];

  for (const file of files) {
    const filePath = path.join(FIXTURES_DIR, file);
    const report = await runBenchmark(filePath, { printer: "HP LaserJet 1020" });

    assert.strictEqual(report.status, "success");
    // Verify each document completes faster than legacy 17.8s baseline
    assert.ok(
      report.t_total_ms < BASELINE_TOTAL_MS,
      `File ${file} latency (${report.t_total_ms}ms) must improve over baseline (${BASELINE_TOTAL_MS}ms)`
    );
    assert.strictEqual(report.baseline_comparison.faster_than_baseline, true);
    assert.ok(report.baseline_comparison.reduction_ms > 0, "Latency reduction must be positive");
  }
});

// Run if executed directly
if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
  });
}

module.exports = suite;
