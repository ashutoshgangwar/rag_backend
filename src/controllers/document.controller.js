const documentService = require('../services/document.service');
const { ApiError } = require('../middleware/error.middleware');

/**
 * Every file of a multipart upload, whatever field name was used.
 *
 * "file" is kept alongside "files" so the original single-file clients keep
 * working after the switch to multi-file uploads.
 */
function collectFiles(req) {
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return req.file ? [req.file] : [];
}

/**
 * POST /api/documents/validate - judge the selected PDFs WITHOUT storing them.
 *
 * The UI calls this the moment files are picked, so it can mark each one
 * accepted or rejected and keep Submit disabled until every file is a resume.
 * Nothing is written, nothing is embedded - this is cheap.
 */
async function validateDocuments(req, res) {
  const files = collectFiles(req);
  if (files.length === 0) {
    throw new ApiError(400, 'No file uploaded. Send PDFs in a multipart field named "files".');
  }

  const results = await Promise.all(
    files.map((f) => documentService.inspectPdf(f.buffer, f.originalname))
  );

  const accepted = results.filter((r) => r.accepted).length;
  res.json({
    success: true,
    allAccepted: accepted === results.length,
    accepted,
    rejected: results.length - accepted,
    results,
  });
}

/**
 * POST /api/documents/upload - ingest one or more resumes.
 *
 * Files are processed one at a time on purpose: embedding is the expensive
 * step and running a batch in parallel would just queue up inside Ollama.
 * One bad file does not fail the batch - each gets its own result entry.
 */
async function uploadDocument(req, res) {
  const files = collectFiles(req);
  if (files.length === 0) {
    throw new ApiError(400, 'No file uploaded. Send PDFs in a multipart field named "files".');
  }

  const results = [];
  for (const file of files) {
    try {
      // multer keeps the upload in memory; the bytes go straight to GridFS, so
      // nothing is ever written to local disk.
      const result = await documentService.ingestPdf(
        file.buffer,
        file.originalname,
        file.mimetype
      );
      results.push({
        ...result,
        filename: file.originalname,
        // NOT called `status`: the ingest DTO already carries status:"ready"
        // and clobbering it would break clients that read it.
        outcome: result.deduplicated ? 'duplicate' : 'ingested',
      });
    } catch (err) {
      // A single file was sent and it was refused: answer with the plain
      // error shape the single-file clients already handle.
      if (files.length === 1) throw err;
      results.push({
        ...(err.details || {}),
        filename: file.originalname,
        // "rejected" means the resume gate turned it away; "failed" means
        // something broke (Ollama down, unreadable PDF). Collapsing the two
        // would tell a user their resume is not a resume.
        outcome: isGateRejection(err) ? 'rejected' : 'failed',
        error: err.message,
      });
    }
  }

  const stored = results.filter((r) => r.outcome === 'ingested' || r.outcome === 'duplicate');
  const rejected = results.filter((r) => r.outcome === 'rejected').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;

  res.status(stored.length > 0 ? 201 : 422).json({
    success: stored.length > 0,
    message: buildUploadMessage(results, stored.length, rejected, failed),
    uploaded: stored.length,
    rejected,
    failed,
    results,
    // Backwards compatibility: a single successful upload still answers with
    // the flat shape the existing frontend reads (fileId, pages, ...).
    ...(files.length === 1 && stored.length === 1 ? stored[0] : {}),
  });
}

/** Was this the resume gate turning a file away, or did processing break? */
function isGateRejection(err) {
  return err.status === 422 && Boolean(err.details) && err.details.isResume === false;
}

function buildUploadMessage(results, stored, rejected, failed) {
  const dupes = results.filter((r) => r.outcome === 'duplicate').length;
  const parts = [];
  if (stored - dupes > 0) parts.push(`${stored - dupes} resume(s) stored and indexed`);
  if (dupes) parts.push(`${dupes} already indexed`);
  if (rejected) parts.push(`${rejected} rejected (not a resume)`);
  if (failed) parts.push(`${failed} could not be processed`);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing to do.';
}

/** GET /api/documents - list the stored PDFs. */
async function listDocuments(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const [{ files, total }, stats] = await Promise.all([
    documentService.listFiles(limit, offset),
    documentService.stats(),
  ]);

  res.json({ success: true, total, limit, offset, files, stats });
}

/** GET /api/documents/:id - one PDF's metadata and ingestion status. */
async function getDocument(req, res) {
  const file = await documentService.getFile(req.params.id);
  res.json({
    success: true,
    file: {
      id: file._id.toString(),
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      pageCount: file.pageCount,
      chunkCount: file.chunkCount,
      characters: file.characters,
      status: file.status,
      error: file.error,
      createdAt: file.createdAt,
    },
  });
}

/** GET /api/documents/:id/chunks - preview stored chunks (never embeddings). */
async function listDocumentChunks(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const { chunks, total } = await documentService.listChunks(req.params.id, limit, offset);
  res.json({ success: true, total, limit, offset, chunks });
}

/**
 * GET /api/documents/:id/download - stream the ORIGINAL PDF back.
 * This is only possible because the bytes were kept in GridFS at upload time.
 */
async function downloadDocument(req, res) {
  const file = await documentService.getFile(req.params.id);
  if (!file.gridfsId) throw new ApiError(404, 'The original file is no longer stored.');

  res.setHeader('Content-Type', file.mimeType || 'application/pdf');
  // The filename is quoted and stripped of quotes/newlines so it cannot be
  // used to inject extra header directives.
  const safeName = String(file.filename).replace(/["\r\n]/g, '');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);

  const stream = documentService.openDownloadStream(file.gridfsId);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500);
    res.end();
    console.error('[download] stream failed:', err.message);
  });
  stream.pipe(res);
}

/** DELETE /api/documents/:id - remove one PDF, its chunks and its bytes. */
async function deleteDocument(req, res) {
  const { filename, chunksDeleted } = await documentService.deleteFile(req.params.id);
  res.json({
    success: true,
    message: `Deleted "${filename}" and ${chunksDeleted} chunk(s).`,
    chunksDeleted,
  });
}

/** DELETE /api/documents - wipe the knowledge base. */
async function clearDocuments(req, res) {
  const { filesDeleted, chunksDeleted } = await documentService.clearAll();
  res.json({
    success: true,
    message: `Deleted ${filesDeleted} file(s) and ${chunksDeleted} chunk(s).`,
    filesDeleted,
    chunksDeleted,
  });
}

module.exports = {
  uploadDocument,
  validateDocuments,
  listDocuments,
  getDocument,
  listDocumentChunks,
  downloadDocument,
  deleteDocument,
  clearDocuments,
};
