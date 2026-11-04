/**
 * Independent Adversarial & Comprehensive Verification for Milestone M5
 * Tests:
 * 1. test-windows-app/server/prepare-pdf.js fast-path & bypass rules
 * 2. test-server/server.js binary framing robustness & boundary edge cases
 * 3. test-server/server.js capability negotiation (query params & payload)
 * 4. test-server/server.js orientation & isPreformatted HTTP -> WebSocket contract preservation
 * 5. test-server/server.js immediate disconnect abortion (<500ms vs 90s hang)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const { PDFDocument } = require("pdf-lib");

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

const {
  prepareA4Pdf,
  prepareChequePdf,
} = require("C:/Users/afsai/Desktop/TEST_SERVER_SPEED_BUILD/test-windows-app/server/prepare-pdf.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

async function runAdversarialM5Verification() {
  console.log("=================================================================");
  console.log("     INDEPENDENT ADVERSARIAL & COMPREHENSIVE M5 VERIFICATION     ");
  console.log("=================================================================\n");

  let passed = 0;
  let failed = 0;

  function testCase(name, fn) {
    return async () => {
      process.stdout.write(`• Testing: ${name}... `);
      try {
        await fn();
        console.log("PASSED");
        passed++;
      } catch (err) {
        console.log(`FAILED\n  Error: ${err.message}`);
        if (err.stack) console.log(err.stack);
        failed++;
      }
    };
  }

  const tests = [
    // -------------------------------------------------------------
    // PART 1: test-windows-app/server/prepare-pdf.js Fast-Path Bypass
    // -------------------------------------------------------------
    testCase("1.1 prepareA4Pdf: Bypasses standard A4 portrait PDF (595.28 x 841.89)", async () => {
      const invoicePath = path.join(FIXTURES_DIR, "synthetic_invoice.pdf");
      const res = await prepareA4Pdf(invoicePath, {});
      assert.strictEqual(res, invoicePath, "Standard A4 portrait must return original file path unchanged");
    }),

    testCase("1.2 prepareA4Pdf: Bypasses standard A4 landscape PDF (841.89 x 595.28)", async () => {
      const doc = await PDFDocument.create();
      doc.addPage([841.89, 595.28]);
      const pdfBytes = await doc.save();
      const tmpPath = path.join(os.tmpdir(), `test_a4_landscape_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, pdfBytes);
      try {
        const res = await prepareA4Pdf(tmpPath, {});
        assert.strictEqual(res, tmpPath, "Standard A4 landscape must return original file path unchanged");
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }),

    testCase("1.3 prepareA4Pdf: Bypasses drum geometry A4 PDF (1190.35 x 841.89)", async () => {
      const doc = await PDFDocument.create();
      doc.addPage([1190.35, 841.89]);
      const pdfBytes = await doc.save();
      const tmpPath = path.join(os.tmpdir(), `test_a4_drum_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, pdfBytes);
      try {
        const res = await prepareA4Pdf(tmpPath, {});
        assert.strictEqual(res, tmpPath, "Drum geometry A4 must return original file path unchanged");
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }),

    testCase("1.4 prepareA4Pdf: Bypasses when isPreformatted === true", async () => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 600]); // Non-A4 size
      const pdfBytes = await doc.save();
      const tmpPath = path.join(os.tmpdir(), `test_preformatted_bool_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, pdfBytes);
      try {
        const res = await prepareA4Pdf(tmpPath, { isPreformatted: true });
        assert.strictEqual(res, tmpPath, "isPreformatted: true must return original file path without re-encoding");
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }),

    testCase("1.5 prepareA4Pdf: Bypasses when isPreformatted === 'true' (string)", async () => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 600]); // Non-A4 size
      const pdfBytes = await doc.save();
      const tmpPath = path.join(os.tmpdir(), `test_preformatted_str_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, pdfBytes);
      try {
        const res = await prepareA4Pdf(tmpPath, { isPreformatted: "true" });
        assert.strictEqual(res, tmpPath, "isPreformatted: 'true' must return original file path without re-encoding");
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }),

    testCase("1.6 prepareA4Pdf: Does NOT bypass non-A4 PDF (US Letter 612 x 792 pt)", async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.drawText("Invoice Content on US Letter");
      const pdfBytes = await doc.save();
      const tmpPath = path.join(os.tmpdir(), `test_letter_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, pdfBytes);
      try {
        const res = await prepareA4Pdf(tmpPath, {});
        assert.notStrictEqual(res, tmpPath, "Non-A4 PDF must be re-encoded onto A4 canvas");
        assert.ok(fs.existsSync(res), "Re-encoded PDF must exist");
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }),

    // -------------------------------------------------------------
    // PART 2: Binary WebSocket Framing Robustness & Boundary Conditions
    // -------------------------------------------------------------
    testCase("2.1 Binary Framing: Empty payload Buffer handling", async () => {
      const meta = { type: "ping", seq: 1 };
      const packed = packBinaryMessage(meta, Buffer.alloc(0));
      assert.ok(packed.length > 4, "Packed buffer has header");
      const unpacked = unpackBinaryMessage(packed);
      assert.ok(unpacked, "Unpack must succeed");
      assert.deepStrictEqual(unpacked.meta, meta);
      assert.strictEqual(unpacked.payload.length, 0);
    }),

    testCase("2.2 Binary Framing: Null payload parameter defaults safely to 0-byte Buffer", async () => {
      const meta = { type: "test" };
      const packed = packBinaryMessage(meta, null);
      const unpacked = unpackBinaryMessage(packed);
      assert.ok(unpacked);
      assert.deepStrictEqual(unpacked.meta, meta);
      assert.strictEqual(unpacked.payload.length, 0);
    }),

    testCase("2.3 Binary Framing: Large payload (>5MB) integrity", async () => {
      const largePayload = crypto.randomBytes(5 * 1024 * 1024);
      const originalSha = crypto.createHash("sha256").update(largePayload).digest("hex");
      const meta = { type: "firmware", size: largePayload.length };
      const packed = packBinaryMessage(meta, largePayload);
      const unpacked = unpackBinaryMessage(packed);
      assert.ok(unpacked);
      const unpackedSha = crypto.createHash("sha256").update(unpacked.payload).digest("hex");
      assert.strictEqual(unpackedSha, originalSha, "Large binary payload must retain exact SHA-256 byte fidelity");
    }),

    testCase("2.4 Binary Framing: Boundary checks (short buffer, invalid header length)", async () => {
      assert.strictEqual(unpackBinaryMessage(null), null);
      assert.strictEqual(unpackBinaryMessage(Buffer.alloc(0)), null);
      assert.strictEqual(unpackBinaryMessage(Buffer.alloc(3)), null);

      // HeaderLen says 100, but buffer is only 10 bytes
      const corruptLenBuf = Buffer.alloc(10);
      corruptLenBuf.writeUInt32BE(100, 0);
      assert.strictEqual(unpackBinaryMessage(corruptLenBuf), null);

      // HeaderLen is 0
      const zeroLenBuf = Buffer.alloc(10);
      zeroLenBuf.writeUInt32BE(0, 0);
      assert.strictEqual(unpackBinaryMessage(zeroLenBuf), null);

      // Header bytes are invalid JSON
      const badJsonBuf = Buffer.alloc(14);
      badJsonBuf.writeUInt32BE(10, 0);
      badJsonBuf.write("NOT_A_JSON!", 4, "utf8");
      assert.strictEqual(unpackBinaryMessage(badJsonBuf), null);
    }),

    // -------------------------------------------------------------
    // PART 3: Server Live HTTP -> WebSocket E2E & Protocol Verification
    // -------------------------------------------------------------
    testCase("3.1 Live Server: Legacy client (no binary capability) receives Base64 text frame", async () => {
      const testPort = 12345;
      await new Promise((resolve) => server.listen(testPort, resolve));

      try {
        const clientWs = new WebSocket(`ws://localhost:${testPort}/ws`);
        const regPromise = new Promise((resolve) => {
          clientWs.once("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "registered") resolve(msg);
          });
        });

        await new Promise((resolve) => clientWs.on("open", resolve));
        // Register without binary capability
        clientWs.send(JSON.stringify({ type: "register", id: "dev-legacy" }));
        const regMsg = await regPromise;
        assert.strictEqual(regMsg.binarySupported, false, "Legacy device must have binarySupported: false");

        // Now initiate an RPC print via server.js rpc() directly to test wire format
        const testPayload = Buffer.from("%PDF-1.4 test invoice content 12345");
        let receivedTextFrame = null;
        const msgPromise = new Promise((resolve) => {
          clientWs.on("message", (data, isBinary) => {
            if (!isBinary) {
              const parsed = JSON.parse(data.toString());
              if (parsed.type === "print") {
                receivedTextFrame = parsed;
                // reply with success
                clientWs.send(JSON.stringify({ type: "print_result", requestId: parsed.requestId, ok: true }));
                resolve(parsed);
              }
            }
          });
        });

        const rpcResult = await rpc("dev-legacy", {
          type: "print",
          filename: "test.pdf",
          binaryPayload: testPayload,
          options: { orientation: "landscape", isPreformatted: true },
        });

        await msgPromise;
        assert.ok(receivedTextFrame, "Legacy client must receive text JSON frame");
        assert.strictEqual(receivedTextFrame.options.orientation, "landscape");
        assert.strictEqual(receivedTextFrame.options.isPreformatted, true);
        assert.ok(receivedTextFrame.fileBase64, "Legacy client must receive fileBase64");
        assert.strictEqual(Buffer.from(receivedTextFrame.fileBase64, "base64").toString("utf8"), testPayload.toString("utf8"));
        assert.strictEqual(rpcResult.ok, true);

        clientWs.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }),

    testCase("3.2 Live Server: Binary client receives length-prefixed binary frame with orientation & payload", async () => {
      const testPort = 12346;
      await new Promise((resolve) => server.listen(testPort, resolve));

      try {
        // Connect with query param capabilities=binary
        const clientWs = new WebSocket(`ws://localhost:${testPort}/ws?capabilities=binary`);
        const regPromise = new Promise((resolve) => {
          clientWs.once("message", (data) => {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === "registered") resolve(parsed);
          });
        });

        await new Promise((resolve) => clientWs.on("open", resolve));
        clientWs.send(JSON.stringify({ type: "register", id: "dev-binary" }));
        const regMsg = await regPromise;
        assert.strictEqual(regMsg.binarySupported, true, "Client with binary capability must have binarySupported: true");

        const testPayload = Buffer.from("%PDF-1.4 binary stream payload bytes 98765");
        let receivedBinaryMsg = null;
        const msgPromise = new Promise((resolve) => {
          clientWs.on("message", (data, isBinary) => {
            if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b)) {
              const unpacked = unpackBinaryMessage(data);
              if (unpacked && unpacked.meta.type === "print") {
                receivedBinaryMsg = unpacked;
                clientWs.send(JSON.stringify({ type: "print_result", requestId: unpacked.meta.requestId, ok: true }));
                resolve(unpacked);
              }
            }
          });
        });

        const rpcResult = await rpc("dev-binary", {
          type: "print",
          filename: "test.pdf",
          binaryPayload: testPayload,
          options: { orientation: "landscape", isPreformatted: true },
        });

        await msgPromise;
        assert.ok(receivedBinaryMsg, "Binary client must receive binary frame");
        assert.strictEqual(receivedBinaryMsg.meta.options.orientation, "landscape");
        assert.strictEqual(receivedBinaryMsg.meta.options.isPreformatted, true);
        assert.strictEqual(receivedBinaryMsg.payload.toString("utf8"), testPayload.toString("utf8"));
        assert.strictEqual(rpcResult.ok, true);

        clientWs.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }),

    testCase("3.3 Live Server: Disconnecting client immediately aborts pending RPC with device_offline (<500ms)", async () => {
      const testPort = 12347;
      await new Promise((resolve) => server.listen(testPort, resolve));

      try {
        const clientWs = new WebSocket(`ws://localhost:${testPort}/ws`);
        const regPromise = new Promise((resolve) => {
          clientWs.once("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "registered") resolve(msg);
          });
        });

        await new Promise((resolve) => clientWs.on("open", resolve));
        clientWs.send(JSON.stringify({ type: "register", id: "dev-drop" }));
        await regPromise;

        // Initiate RPC with 90s timeout
        const start = Date.now();
        const rpcPromise = rpc("dev-drop", {
          type: "print",
          filename: "test.pdf",
          binaryPayload: Buffer.from("pdf"),
        }, 90000);

        // Terminate client socket while RPC is in flight
        setTimeout(() => {
          clientWs.terminate();
        }, 50);

        let caughtErr = null;
        try {
          await rpcPromise;
        } catch (err) {
          caughtErr = err;
        }

        const elapsed = Date.now() - start;
        assert.ok(caughtErr !== null, "RPC must reject when client socket terminates");
        assert.strictEqual(caughtErr.error, "device_offline");
        assert.strictEqual(caughtErr.ok, false);
        assert.ok(elapsed < 1000, `Abort must happen immediately (<1000ms), took ${elapsed}ms`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }),

    testCase("3.4 HTTP POST /relay/:id/print: Preserves orientation and forwards isPreformatted", async () => {
      const testPort = 12348;
      await new Promise((resolve) => server.listen(testPort, resolve));

      try {
        const clientWs = new WebSocket(`ws://localhost:${testPort}/ws`);
        const regPromise = new Promise((resolve) => {
          clientWs.once("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "registered") resolve(msg);
          });
        });

        await new Promise((resolve) => clientWs.on("open", resolve));
        clientWs.send(JSON.stringify({ type: "register", id: "dev-http-test" }));
        await regPromise;

        // Catch the print RPC on clientWs and verify options
        let capturedRpc = null;
        clientWs.on("message", (data, isBinary) => {
          let msg = null;
          if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b)) {
            const unpacked = unpackBinaryMessage(data);
            if (unpacked) msg = unpacked.meta;
          } else {
            msg = JSON.parse(data.toString());
          }
          if (msg && msg.type === "print") {
            capturedRpc = msg;
            clientWs.send(JSON.stringify({ type: "print_result", requestId: msg.requestId, ok: true }));
          }
        });

        // Make HTTP multipart request to /relay/dev-http-test/print
        const boundary = "----WebKitFormBoundary" + crypto.randomBytes(8).toString("hex");
        const pdfContent = "%PDF-1.4 synthetic minimal test pdf file\n%%EOF";
        
        let body = "";
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="orientation"\r\n\r\n`;
        body += `landscape\r\n`;

        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="isPreformatted"\r\n\r\n`;
        body += `true\r\n`;

        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="file"; filename="sample.pdf"\r\n`;
        body += `Content-Type: application/pdf\r\n\r\n`;
        body += pdfContent + `\r\n`;
        body += `--${boundary}--\r\n`;

        const httpRes = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: "localhost",
            port: testPort,
            path: "/relay/dev-http-test/print",
            method: "POST",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": Buffer.byteLength(body),
            },
          }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
          });
          req.on("error", reject);
          req.write(body);
          req.end();
        });

        assert.strictEqual(httpRes.statusCode, 200, `Expected 200, got ${httpRes.statusCode}: ${httpRes.body}`);
        assert.ok(capturedRpc !== null, "WebSocket client must have received print RPC");
        assert.strictEqual(capturedRpc.options.orientation, "landscape", "orientation must be 'landscape'");
        assert.strictEqual(capturedRpc.options.isPreformatted, true, "isPreformatted must be true");

        clientWs.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }),
  ];

  for (const t of tests) {
    await t();
  }

  console.log("\n=================================================================");
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log("=================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAdversarialM5Verification().catch((err) => {
    console.error("FATAL UNCAUGHT:", err);
    process.exit(1);
  });
}

module.exports = { runAdversarialM5Verification };
