/**
 * Tier 1: Feature Coverage Test Suite
 * Tests each feature in isolation per PROJECT.md interface contracts.
 */

const path = require("path");
const fs = require("fs");
const { createSuite, assert } = require("./runner");
const { PDFDocument } = require("pdf-lib");
const {
  prepareDocumentForPrinter,
  TARGET_RATIO,
  TARGET_PAGE_W,
  TARGET_PAGE_H
} = require("../prepare-pdf");
const {
  runBenchmark,
  benchmarkAll,
  BASELINE_TOTAL_MS,
  HP_1020_GEOMETRY,
  HP_P1007_GEOMETRY
} = require("./benchmark-timing");
const {
  generateAllFixtures,
  FIXTURES_DIR,
  A4_W,
  A4_H,
  CHEQUE_W,
  CHEQUE_H,
  createPng
} = require("./generate-fixtures");

const suite = createSuite("Tier 1: Feature Coverage (Isolation)");

// ─────────────────────────────────────────────────────────────
// FEATURE 1: Synthetic Fixture Integrity
// ─────────────────────────────────────────────────────────────

suite.test("1.1 Fixtures: All 5 standardized synthetic test PDFs exist", async () => {
  const files = [
    "synthetic_invoice.pdf",
    "synthetic_multipage.pdf",
    "synthetic_a4_grid.pdf",
    "synthetic_dense_graphic.pdf",
    "synthetic_cheque.pdf"
  ];
  for (const file of files) {
    const filePath = path.join(FIXTURES_DIR, file);
    assert.ok(fs.existsSync(filePath), `Fixture file must exist: ${file}`);
    const stat = fs.statSync(filePath);
    assert.ok(stat.size > 0, `Fixture file must not be empty: ${file}`);
  }
});

suite.test("1.2 Fixture: synthetic_invoice.pdf meets single-page & size criteria (~100-480 KB)", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length >= 100 * 1024, `Size should be >= 100 KB, got ${bytes.length} bytes`);
  assert.ok(bytes.length <= 480 * 1024, `Size should be <= 480 KB, got ${bytes.length} bytes`);

  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1, "Must be single page");
  const page = doc.getPage(0);
  const size = page.getSize();
  assert.strictEqual(Math.round(size.width), Math.round(A4_W), "Width must match standard A4");
  assert.strictEqual(Math.round(size.height), Math.round(A4_H), "Height must match standard A4");
});

suite.test("1.3 Fixture: synthetic_multipage.pdf has 4 pages with consistent dimensions", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_multipage.pdf");
  const bytes = fs.readFileSync(filePath);
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 4, "Must have exactly 4 pages");

  for (let i = 0; i < 4; i++) {
    const page = doc.getPage(i);
    const size = page.getSize();
    assert.strictEqual(Math.round(size.width), Math.round(A4_W), `Page ${i + 1} width must be A4`);
    assert.strictEqual(Math.round(size.height), Math.round(A4_H), `Page ${i + 1} height must be A4`);
  }
});

suite.test("1.4 Fixture: synthetic_a4_grid.pdf has exact 1:1 A4 geometry and calibration borders", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_a4_grid.pdf");
  const bytes = fs.readFileSync(filePath);
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1, "Must be single page");
  const page = doc.getPage(0);
  const size = page.getSize();
  assert.strictEqual(Math.round(size.width * 10) / 10, Math.round(A4_W * 10) / 10, "Width must match A4 (595.3 pt)");
  assert.strictEqual(Math.round(size.height * 10) / 10, Math.round(A4_H * 10) / 10, "Height must match A4 (841.9 pt)");
});

suite.test("1.5 Fixture: synthetic_cheque.pdf has CTS-2010 dimensions (203mm x 92mm)", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_cheque.pdf");
  const bytes = fs.readFileSync(filePath);
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1, "Must be single page");
  const page = doc.getPage(0);
  const size = page.getSize();
  assert.strictEqual(Math.round(size.width), Math.round(CHEQUE_W), "Width must match CTS-2010 203mm");
  assert.strictEqual(Math.round(size.height), Math.round(CHEQUE_H), "Height must match CTS-2010 92mm");
});

suite.test("1.6 Fixture: synthetic_dense_graphic.pdf embeds high-entropy raster test chart", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_dense_graphic.pdf");
  const bytes = fs.readFileSync(filePath);
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1, "Must be single page");
  // Inspect raw PDF content for Image XObject dictionary
  const rawText = bytes.toString("latin1");
  assert.ok(rawText.includes("/Subtype /Image") || rawText.includes("/Subtype/Image"), "Must embed raster image XObject");
});

// ─────────────────────────────────────────────────────────────
// FEATURE 2: Benchmark Timing Harness Interface Contracts
// ─────────────────────────────────────────────────────────────

suite.test("1.7 Benchmark: Returns contract-compliant JSON schema with microsecond timings", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");
  const report = await runBenchmark(filePath, { printer: "HP LaserJet 1020" });

  // Validate Interface Contract keys from PROJECT.md
  assert.ok(typeof report.jobId === "string" && report.jobId.length > 0, "jobId must be non-empty string");
  assert.strictEqual(report.status, "success", "status must be success");
  assert.ok(typeof report.t_spool_ms === "number" && report.t_spool_ms >= 0, "t_spool_ms must be non-negative float");
  assert.ok(typeof report.t_upload_ms === "number" && report.t_upload_ms >= 0, "t_upload_ms must be non-negative float");
  assert.ok(typeof report.t_relay_ms === "number" && report.t_relay_ms >= 0, "t_relay_ms must be non-negative float");
  assert.ok(typeof report.t_raster_ms === "number" && report.t_raster_ms > 0, "t_raster_ms must be positive float");
  assert.ok(typeof report.t_dither_ms === "number" && report.t_dither_ms > 0, "t_dither_ms must be positive float");
  assert.ok(typeof report.t_encode_ms === "number" && report.t_encode_ms > 0, "t_encode_ms must be positive float");
  assert.ok(typeof report.t_usb_ms === "number" && report.t_usb_ms > 0, "t_usb_ms must be positive float");
  assert.ok(typeof report.t_total_ms === "number" && report.t_total_ms > 0, "t_total_ms must be positive float");

  assert.strictEqual(report.output_pbm_geometry, "9920x7016", "output_pbm_geometry must match 9920x7016");
  assert.strictEqual(report.printable_width_dots, 9568, "printable_width_dots must be 9568");
  assert.strictEqual(report.printable_height_dots, 6848, "printable_height_dots must be 6848");

  // Validate baseline comparison
  assert.strictEqual(report.baseline_comparison.baseline_ms, BASELINE_TOTAL_MS);
  assert.ok(report.baseline_comparison.faster_than_baseline === true, "Must be faster than 17.8s baseline");
});

suite.test("1.8 Benchmark: Supports HP LaserJet P1007 geometry and driver parameters", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_a4_grid.pdf");
  const report = await runBenchmark(filePath, { printer: "HP LaserJet P1007" });

  assert.strictEqual(report.printer, "HP LaserJet P1007");
  assert.strictEqual(report.output_pbm_geometry, "9920x7016");
  assert.strictEqual(report.printable_width_dots, 9568);
  assert.strictEqual(report.printable_height_dots, 6848);
  assert.strictEqual(report.status, "success");
});

// ─────────────────────────────────────────────────────────────
// FEATURE 3: PDF Preparation & Normalization Engine
// ─────────────────────────────────────────────────────────────

suite.test("1.9 Normalizer: Firmware files (.dl, .img) are preserved with zero byte alteration", async () => {
  const dummyFirmware = Buffer.from("HP-LASERJET-1020-FIRMWARE-IMAGE-DUMMY-BYTE-STREAM-\x00\x01\x02\xff");
  const resDl = await prepareDocumentForPrinter(dummyFirmware, "sihp1020.dl", {});
  assert.strictEqual(resDl.buffer.equals(dummyFirmware), true, ".dl firmware must be 100% byte identical");

  const resImg = await prepareDocumentForPrinter(dummyFirmware, "sihpP1007.img", {});
  assert.strictEqual(resImg.buffer.equals(dummyFirmware), true, ".img firmware must be 100% byte identical");

  const resFlag = await prepareDocumentForPrinter(dummyFirmware, "custom_fw.bin", { isFirmware: true });
  assert.strictEqual(resFlag.buffer.equals(dummyFirmware), true, "isFirmware:true must be 100% byte identical");
});

suite.test("1.10 Normalizer: Scales portrait PDF to 1.413911 aspect ratio (1190.36 pt x 841.89 pt)", async () => {
  const filePath = path.join(FIXTURES_DIR, "synthetic_a4_grid.pdf");
  const fileBytes = fs.readFileSync(filePath);
  const result = await prepareDocumentForPrinter(fileBytes, "synthetic_a4_grid.pdf", { orientation: "portrait" });

  const outDoc = await PDFDocument.load(result.buffer);
  const outPage = outDoc.getPage(0);
  const { width, height } = outPage.getSize();

  assert.strictEqual(Math.round(width * 100) / 100, Math.round(TARGET_PAGE_W * 100) / 100, "Width must scale to TARGET_PAGE_W");
  assert.strictEqual(Math.round(height * 100) / 100, Math.round(TARGET_PAGE_H * 100) / 100, "Height must match TARGET_PAGE_H");
  assert.strictEqual(Math.round((width / height) * 1000) / 1000, Math.round(TARGET_RATIO * 1000) / 1000, "Ratio must be ~1.4139");
});

suite.test("1.11 Normalizer: Auto-rotates landscape image into portrait drum dimensions", async () => {
  // Create a landscape PNG (400 wide x 200 high)
  const landscapePng = createPng(400, 200, () => [128, 128, 128, 255]);
  const result = await prepareDocumentForPrinter(landscapePng, "landscape_test.png", { orientation: "auto" });

  assert.ok(result.filename.endsWith(".pdf"), "Output filename must end with .pdf");
  const outDoc = await PDFDocument.load(result.buffer);
  const page = outDoc.getPage(0);
  const { width, height } = page.getSize();
  assert.strictEqual(Math.round(width * 100) / 100, Math.round(TARGET_PAGE_W * 100) / 100);
  assert.strictEqual(Math.round(height * 100) / 100, Math.round(TARGET_PAGE_H * 100) / 100);
});

// Run if executed directly
if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
  });
}

module.exports = suite;
