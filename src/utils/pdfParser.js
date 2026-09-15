const { PDFParse } = require('pdf-parse');
const { ApiError } = require('../middleware/error.middleware');

/**
 * Extract text from a PDF buffer, PER PAGE.
 *
 * pdf-parse v2 exposes a class API whose TextResult carries both the whole
 * document text and a `pages: [{ num, text }]` array. We keep the per-page
 * breakdown because it is what lets a retrieved chunk cite "page 7" instead
 * of just pointing at a wall of text.
 *
 * We never send the PDF itself to the LLM - we only ever send small text
 * chunks that were retrieved for a specific question.
 *
 * @param {Buffer} buffer raw PDF bytes
 * @returns {Promise<{ text: string, pages: Array<{ num: number, text: string }>, pageCount: number }>}
 */
async function extractTextFromPdf(buffer) {
  assertLooksLikePdf(buffer);

  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const pages = Array.isArray(result.pages)
      ? result.pages.map((p) => ({ num: p.num, text: p.text || '' }))
      : [];

    return {
      text: result.text || '',
      pages,
      pageCount: result.total || pages.length,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, `Could not read the PDF: ${err.message}`);
  } finally {
    if (parser) {
      // Release the pdf.js worker; otherwise the process can hang on exit.
      await parser.destroy().catch(() => {});
    }
  }
}

/** Cheap structural checks before handing bytes to the parser. */
function assertLooksLikePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, 'The uploaded PDF is empty (0 bytes).');
  }
  // Every real PDF starts with the magic bytes "%PDF-".
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ApiError(400, 'The uploaded file is not a valid PDF.');
  }
}

module.exports = { extractTextFromPdf };
