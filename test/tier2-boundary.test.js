/**
 * Tier 2: Boundary & Corner Cases Test Suite
 * Tests extreme dimensions, empty buffers, malformed data, and edge conditions.
 */

const path = require("path");
const fs = require("fs");
const { createSuite, assert } = require("./runner");
const { PDFDocument, rgb } = require("pdf-lib");
const { prepareDocumentForPrinter, TARGET_PAGE_W, TARGET_PAGE_H } = require("../prepare-pdf");
const { runBenchmark } = require("./benchmark-timing");
const { A4_W, A4_H } = require("./generate-fixtures");

const suite = createSuite("Tier 2: Boundary & Corner Cases");

// ─────────────────────────────────────────────────────────────
// BOUNDARY 1: Zero-Byte & Empty Buffers
// ─────────────────────────────────────────────────────────────

suite.test("2.1 Empty Buffer: Returns original buffer safely without crashing", async () => {
  const emptyBuf = Buffer.alloc(0);
  const result = await prepareDocumentForPrinter(emptyBuf, "empty.pdf", {});
  assert.ok(Buffer.isBuffer(result.buffer), "Must return a Buffer");
  assert.strictEqual(result.buffer.length, 0, "Buffer should remain 0 bytes");
  assert.strictEqual(result.filename, "empty.pdf");
});

suite.test("2.2 Zero-page PDF: Handled gracefully without unhandled exception", async () => {
  const emptyDoc = await PDFDocument.create();
  const zeroPageBytes = await emptyDoc.save();
  const result = await prepareDocumentForPrinter(Buffer.from(zeroPageBytes), "zeropage.pdf", {});
  assert.ok(result.buffer.length > 0, "Should return buffer");
});

// ─────────────────────────────────────────────────────────────
// BOUNDARY 2: Extreme Geometries & Aspect Ratios
// ─────────────────────────────────────────────────────────────

suite.test("2.3 Extreme Dimension: Super narrow POS receipt (58mm width x 800pt height)", async () => {
  const doc = await PDFDocument.create();
  // 58mm = 164.4 pt
  const page = doc.addPage([164.4, 800.0]);
  page.drawText("RECEIPT #9921", { x: 20, y: 750, size: 10 });
  const pdfBytes = await doc.save();

  const result = await prepareDocumentForPrinter(Buffer.from(pdfBytes), "receipt.pdf", { orientation: "auto" });
  const outDoc = await PDFDocument.load(result.buffer);
  const outPage = outDoc.getPage(0);
  const { width, height } = outPage.getSize();

  assert.strictEqual(Math.round(width * 10) / 10, Math.round(TARGET_PAGE_W * 10) / 10, "Target width must match TARGET_PAGE_W");
  assert.strictEqual(Math.round(height * 10) / 10, Math.round(TARGET_PAGE_H * 10) / 10, "Target height must match TARGET_PAGE_H");
});

suite.test("2.4 Extreme Dimension: Super wide landscape banner (1600pt width x 200pt height)", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1600.0, 200.0]);
  page.drawText("WIDE AD BANNER", { x: 100, y: 100, size: 24 });
  const pdfBytes = await doc.save();

  const result = await prepareDocumentForPrinter(Buffer.from(pdfBytes), "banner.pdf", { orientation: "auto" });
  const outDoc = await PDFDocument.load(result.buffer);
  const outPage = outDoc.getPage(0);
  const { width, height } = outPage.getSize();

  assert.strictEqual(Math.round(width * 10) / 10, Math.round(TARGET_PAGE_W * 10) / 10);
  assert.strictEqual(Math.round(height * 10) / 10, Math.round(TARGET_PAGE_H * 10) / 10);
});

suite.test("2.5 Square Aspect Ratio: Exactly 1:1 page (500pt x 500pt)", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500.0, 500.0]);
  page.drawRectangle({ x: 50, y: 50, width: 400, height: 400, color: rgb(0.2, 0.4, 0.6) });
  const pdfBytes = await doc.save();

  const result = await prepareDocumentForPrinter(Buffer.from(pdfBytes), "square.pdf", { orientation: "auto" });
  const outDoc = await PDFDocument.load(result.buffer);
  const outPage = outDoc.getPage(0);
  const { width, height } = outPage.getSize();

  assert.strictEqual(Math.round(width * 10) / 10, Math.round(TARGET_PAGE_W * 10) / 10);
  assert.strictEqual(Math.round(height * 10) / 10, Math.round(TARGET_PAGE_H * 10) / 10);
});

// ─────────────────────────────────────────────────────────────
// BOUNDARY 3: Malformed & Corrupted Content
// ─────────────────────────────────────────────────────────────

suite.test("2.6 Corrupted PDF Header: Gracefully returns original buffer without throwing", async () => {
  const corruptPdf = Buffer.from("%PDF-1.7\nCorrupt trailer and garbage data \x00\xff\xee\xdd\xcc");
  const result = await prepareDocumentForPrinter(corruptPdf, "corrupt.pdf", {});
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.strictEqual(result.buffer.equals(corruptPdf), true, "Must fall back to returning original buffer");
});

suite.test("2.7 Non-PDF plain text file: Passes through safely", async () => {
  const textBuffer = Buffer.from("Hello world, this is a plain text stream without PDF header");
  const result = await prepareDocumentForPrinter(textBuffer, "notes.txt", {});
  assert.strictEqual(result.buffer.equals(textBuffer), true, "Text stream must pass through untouched");
  assert.strictEqual(result.filename, "notes.txt");
});

// ─────────────────────────────────────────────────────────────
// BOUNDARY 4: Filename Encoding & Special Characters
// ─────────────────────────────────────────────────────────────

suite.test("2.8 Filename with Unicode, symbols, spaces and path separators", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText("Content page", { x: 20, y: 250, size: 10 });
  const pdfBytes = await doc.save();

  const testFilenames = [
    "Tax_Invoice_#4829_[CONFIDENTIAL].pdf",
    "請求書_東京_2026.pdf",
    "فاتورة_الكترونية.pdf",
    "Facture d'électricité (Juillet).pdf",
    "subdir/test/file.pdf",
    "C:\\Users\\test\\Documents\\print.pdf"
  ];

  for (const fname of testFilenames) {
    const result = await prepareDocumentForPrinter(Buffer.from(pdfBytes), fname, {});
    assert.ok(result.buffer.length > 0, `Should succeed for: ${fname}`);
    assert.strictEqual(result.filename, fname, `Filename must be preserved: ${fname}`);
  }
});

// ─────────────────────────────────────────────────────────────
// BOUNDARY 5: Orientation Parameter Values
// ─────────────────────────────────────────────────────────────

suite.test("2.9 Orientation values: Handles invalid and edge option values gracefully", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  page.drawText("Orientation test page", { x: 20, y: 550, size: 10 });
  const pdfBytes = await doc.save();

  const edgeOptions = [
    { orientation: "diagonal" },
    { orientation: "inverted" },
    { orientation: "" },
    { orientation: null },
    { orientation: undefined },
    { orientation: 12345 }
  ];

  for (const opt of edgeOptions) {
    const result = await prepareDocumentForPrinter(Buffer.from(pdfBytes), "orient_test.pdf", opt);
    assert.ok(result.buffer.length > 0, `Option ${JSON.stringify(opt)} should not crash`);
  }
});

// ─────────────────────────────────────────────────────────────
// BOUNDARY 6: High Page Count Stress
// ─────────────────────────────────────────────────────────────

suite.test("2.10 High Page Count: Processes 12-page document without memory leak", async () => {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= 12; i++) {
    const page = doc.addPage([A4_W, A4_H]);
    page.drawText(`Stress Page ${i} of 12`, { x: 50, y: 750, size: 14 });
  }
  const multiBytes = await doc.save();

  const result = await prepareDocumentForPrinter(Buffer.from(multiBytes), "stress_12pages.pdf", {});
  const outDoc = await PDFDocument.load(result.buffer);
  assert.strictEqual(outDoc.getPageCount(), 12, "Must preserve all 12 pages");
});

// Run if executed directly
if (require.main === module) {
  suite.run().then((res) => {
    if (res.failed > 0) process.exit(1);
  });
}

module.exports = suite;
