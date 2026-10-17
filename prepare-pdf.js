const { PDFDocument, degrees } = require("pdf-lib");

// HP LaserJet 1020 / P1007 laser engine geometry:
// Horizontal line across 210mm = 9920 dots at 1200 DPI
// Vertical drum length down 297mm = 7016 lines at 600 DPI
// Native aspect ratio = 9920 / 7016 = 1.41391106
const TARGET_RATIO = 9920 / 7016;
const TARGET_PAGE_H = 841.89; // Standard A4 height in points (297mm)
const TARGET_PAGE_W = TARGET_PAGE_H * TARGET_RATIO; // 1190.35758 points

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

/**
 * Normalizes documents for printing on the HP LaserJet 1020 / P1007 via Android or Desktop.
 * - Auto-detects landscape orientation or honors user preference
 * - Rotates landscape documents 90° clockwise to span the 297mm length of the paper
 * - Scales to the 1.413911 aspect ratio required by the 1200x600 DPI laser engine
 *   so that the 2x horizontal laser compression results in a distortion-free 1:1 printout.
 * - Firmware files (.img, .dl) are preserved untouched.
 */
async function prepareDocumentForPrinter(fileBuffer, originalFilename, options = {}) {
  const ext = (originalFilename.match(/\.[^.]+$/) || [""])[0].toLowerCase();

  // 1. Pass firmware images through unchanged
  if (options.isFirmware || ext === ".dl" || ext === ".img") {
    return { buffer: fileBuffer, filename: originalFilename };
  }

  // 2. Handle image files (JPG, PNG)
  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const outDoc = await PDFDocument.create();
      let img = null;
      if (ext === ".jpg" || ext === ".jpeg") {
        img = await outDoc.embedJpg(fileBuffer);
      } else if (ext === ".png") {
        img = await outDoc.embedPng(fileBuffer);
      }

      if (img) {
        const isLandscape = img.width > img.height;
        const shouldBeLandscape =
          options.orientation === "landscape" ||
          (options.orientation !== "portrait" && isLandscape);

        const outPage = outDoc.addPage([TARGET_PAGE_W, TARGET_PAGE_H]);

        if (shouldBeLandscape) {
          outPage.drawImage(img, {
            x: 0,
            y: TARGET_PAGE_H,
            width: TARGET_PAGE_H,
            height: TARGET_PAGE_W,
            rotate: degrees(-90),
          });
        } else {
          outPage.drawImage(img, {
            x: 0,
            y: 0,
            width: TARGET_PAGE_W,
            height: TARGET_PAGE_H,
          });
        }

        const pdfBytes = await outDoc.save();
        const newFilename = originalFilename.replace(/\.[^.]+$/, "") + ".pdf";
        return { buffer: Buffer.from(pdfBytes), filename: newFilename };
      }
    } catch (imgErr) {
      console.warn("[prepare-pdf] Image conversion failed, falling back to raw:", imgErr.message);
      return { buffer: fileBuffer, filename: originalFilename };
    }
  }

  // 3. Handle PDF files
  const isPdf =
    ext === ".pdf" ||
    (fileBuffer.length > 4 && fileBuffer.slice(0, 5).toString("latin1").startsWith("%PDF-"));

  if (!isPdf) {
    return { buffer: fileBuffer, filename: originalFilename };
  }

  try {
    const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const pageCount = srcDoc.getPageCount();
    if (pageCount === 0) return { buffer: fileBuffer, filename: originalFilename };

    const outDoc = await PDFDocument.create();

    for (let i = 0; i < pageCount; i++) {
      const page = srcDoc.getPage(i);
      const { width: rawW, height: rawH } = page.getSize();
      const rot = ((page.getRotation() ? page.getRotation().angle : 0) % 360 + 360) % 360;

      const isRotated90or270 = rot === 90 || rot === 270;
      const visualW = isRotated90or270 ? rawH : rawW;
      const visualH = isRotated90or270 ? rawW : rawH;

      const isLandscapeVisual = visualW > visualH;
      const shouldBeLandscape =
        options.orientation === "landscape" ||
        (options.orientation !== "portrait" && isLandscapeVisual);

      const outPage = outDoc.addPage([TARGET_PAGE_W, TARGET_PAGE_H]);

      try {
        const [embedded] = await outDoc.embedPdf(srcDoc, [i]);

        if (shouldBeLandscape) {
          if (!isRotated90or270) {
            // Standard landscape page
            const angle = rot === 180 ? 90 : -90;
            if (angle === -90) {
              outPage.drawPage(embedded, {
                x: 0,
                y: TARGET_PAGE_H,
                width: TARGET_PAGE_H,
                height: TARGET_PAGE_W,
                rotate: degrees(-90),
              });
            } else {
              outPage.drawPage(embedded, {
                x: TARGET_PAGE_W,
                y: 0,
                width: TARGET_PAGE_H,
                height: TARGET_PAGE_W,
                rotate: degrees(90),
              });
            }
          } else {
            // Page with /Rotate 90 or 270 tag
            if (rot === 90) {
              outPage.drawPage(embedded, {
                x: 0,
                y: 0,
                width: TARGET_PAGE_W,
                height: TARGET_PAGE_H,
              });
            } else {
              outPage.drawPage(embedded, {
                x: TARGET_PAGE_W,
                y: TARGET_PAGE_H,
                width: TARGET_PAGE_W,
                height: TARGET_PAGE_H,
                rotate: degrees(180),
              });
            }
          }
        } else {
          // Portrait page
          if (!isRotated90or270) {
            if (rot === 180) {
              outPage.drawPage(embedded, {
                x: TARGET_PAGE_W,
                y: TARGET_PAGE_H,
                width: TARGET_PAGE_W,
                height: TARGET_PAGE_H,
                rotate: degrees(180),
              });
            } else {
              outPage.drawPage(embedded, {
                x: 0,
                y: 0,
                width: TARGET_PAGE_W,
                height: TARGET_PAGE_H,
              });
            }
          } else {
            if (rot === 90) {
              outPage.drawPage(embedded, {
                x: 0,
                y: TARGET_PAGE_H,
                width: TARGET_PAGE_H,
                height: TARGET_PAGE_W,
                rotate: degrees(-90),
              });
            } else {
              outPage.drawPage(embedded, {
                x: TARGET_PAGE_W,
                y: 0,
                width: TARGET_PAGE_H,
                height: TARGET_PAGE_W,
                rotate: degrees(90),
              });
            }
          }
        }
      } catch (embedErr) {
        // Fallback for pages with unparseable streams
        const [copied] = await outDoc.copyPages(srcDoc, [i]);
        copied.setSize(TARGET_PAGE_W, TARGET_PAGE_H);
        outDoc.addPage(copied);
      }
    }

    const pdfBytes = await outDoc.save();
    return { buffer: Buffer.from(pdfBytes), filename: originalFilename };
  } catch (pdfErr) {
    console.warn("[prepare-pdf] PDF normalization failed, sending original:", pdfErr.message);
    return { buffer: fileBuffer, filename: originalFilename };
  }
}

module.exports = { prepareDocumentForPrinter, TARGET_PAGE_W, TARGET_PAGE_H, TARGET_RATIO };
