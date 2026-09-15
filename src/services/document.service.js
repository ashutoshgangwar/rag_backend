const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ObjectId } = require('mongodb');

const db = require('../config/db');
const { extractTextFromPdf } = require('../utils/pdfParser');
const { chunkText } = require('../utils/chunkText');
const { embedMany } = require('./embedding.service');
const { classifyResume, resumeOnlyEnabled } = require('../utils/resumeClassifier');
const { ApiError } = require('../middleware/error.middleware');

/**
 * The INGESTION half of RAG.
 *
 *   PDF -> GridFS (permanent)
 *       -> extract per page -> chunk -> embed each chunk
 *       -> `chunks` collection (permanent, searchable via $vectorSearch)
 *
 * Both halves are permanent: the original bytes stay in GridFS so the
 * document can be re-chunked or downloaded later, and every chunk keeps a
 * `fileId` back-reference so answers can cite the file and page they came
 * from.
 *
 * The PDF itself is never sent to the LLM. Only small retrieved chunks are,
 * and only at question time.
 */

/**
 * Ingest one PDF end to end.
 *
 * @param {Buffer} buffer the raw PDF bytes
 * @param {string} originalName display name, never used as a path
 * @param {string} mimeType
 */
async function ingestPdf(buffer, originalName, mimeType = 'application/pdf') {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // 0. Same bytes already ingested? Do nothing - embedding is the expensive
  //    part and re-running it would only produce duplicate chunks.
  const existing = await db.files().findOne({ sha256 });
  if (existing && existing.status === 'ready') {
    // Return the SAME shape a fresh ingest returns, so a caller never has to
    // branch on which kind of response it got - only on `deduplicated`.
    return { ...toIngestDto(existing), deduplicated: true };
  }
  if (existing) {
    // A previous attempt failed or was interrupted - clear it and retry.
    await deleteFile(existing._id);
  }

  // 1. Read the text and confirm this really is a resume BEFORE anything is
  //    written anywhere. Rejecting after storeBytes would leave orphaned
  //    bytes in GridFS for every file the gate turns away.
  const { pages, pageCount, text } = await extractTextFromPdf(buffer);
  await assertIsResume(text, pageCount, originalName);

  // 2. Store the original bytes, so the file survives even if the
  //    (much slower) embedding step fails.
  const gridfsId = await storeBytes(buffer, originalName, mimeType, sha256);

  const fileDoc = {
    filename: originalName,
    mimeType,
    sizeBytes: buffer.length,
    sha256,
    gridfsId,
    pageCount: null,
    chunkCount: 0,
    status: 'processing',
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const { insertedId: fileId } = await db.files().insertOne(fileDoc);

  try {
    // 3. per-page text -> overlapping chunks tagged with their page
    const pieces = chunkByPage(pages, text);

    if (pieces.length === 0) {
      throw new ApiError(
        422,
        `No text could be extracted from "${originalName}". ` +
          'Scanned/image-only PDFs need OCR first.'
      );
    }

    console.log(`[ingest] ${originalName}: ${pageCount} pages, ${pieces.length} chunks`);

    // 4. Each chunk -> a 768-dim vector from nomic-embed-text
    const vectors = await embedMany(
      pieces.map((p) => p.content),
      {
        concurrency: 4,
        onProgress: (done, total) => {
          if (done === total || done % 20 === 0) {
            console.log(`[ingest] embedded ${done}/${total} chunks`);
          }
        },
      }
    );

    // 5. Store chunk + vector together
    const docs = pieces.map((piece, i) => ({
      fileId,
      filename: originalName,
      chunkIndex: i,
      pageNumber: piece.pageNumber,
      content: piece.content,
      embedding: vectors[i],
      createdAt: new Date(),
    }));
    await db.chunks().insertMany(docs, { ordered: false });

    await db.files().updateOne(
      { _id: fileId },
      {
        $set: {
          status: 'ready',
          pageCount,
          chunkCount: docs.length,
          characters: text.length,
          updatedAt: new Date(),
        },
      }
    );

    return toIngestDto({
      _id: fileId,
      filename: originalName,
      pageCount,
      characters: text.length,
      chunkCount: docs.length,
      status: 'ready',
    });
  } catch (err) {
    // Record WHY it failed instead of leaving a silent half-ingested file.
    await db.files().updateOne(
      { _id: fileId },
      { $set: { status: 'failed', error: err.message, updatedAt: new Date() } }
    );
    // Chunks written before the failure would be unattributed noise in search.
    await db.chunks().deleteMany({ fileId }).catch(() => {});
    throw err;
  }
}

/**
 * Chunk each page separately so every chunk carries a real page number.
 *
 * The trade-off: a paragraph spanning a page break loses its overlap across
 * that boundary. Accurate citations are worth more than that one seam.
 */
function chunkByPage(pages, wholeText) {
  const options = {
    chunkSize: Number(process.env.CHUNK_SIZE) || 900,
    overlap: Number(process.env.CHUNK_OVERLAP) || 150,
  };

  // Fallback for parsers that return no page breakdown.
  if (!pages || pages.length === 0) {
    return chunkText(wholeText, options).map((content) => ({ content, pageNumber: null }));
  }

  const pieces = [];
  for (const page of pages) {
    for (const content of chunkText(page.text, options)) {
      pieces.push({ content, pageNumber: page.num });
    }
  }
  return pieces;
}

/** Write the PDF into GridFS and resolve to its _id. */
async function storeBytes(buffer, filename, mimeType, sha256) {
  const uploadStream = db.bucket().openUploadStream(filename, {
    contentType: mimeType,
    metadata: { sha256, uploadedAt: new Date() },
  });
  await pipeline(Readable.from(buffer), uploadStream);
  return uploadStream.id;
}

/** A readable stream of the stored PDF, for GET /api/documents/:id/download. */
function openDownloadStream(gridfsId) {
  return db.bucket().openDownloadStream(toObjectId(gridfsId));
}

/** List ingested files (metadata only - never touches chunks or embeddings). */
async function listFiles(limit = 20, offset = 0) {
  const [docs, total] = await Promise.all([
    db.files().find({}).sort({ createdAt: -1 }).skip(offset).limit(limit).toArray(),
    db.files().countDocuments(),
  ]);
  return { files: docs.map(toFileDto), total };
}

async function getFile(id) {
  const doc = await db.files().findOne({ _id: toObjectId(id) });
  if (!doc) throw new ApiError(404, `No document with id "${id}".`);
  return doc;
}

/**
 * Preview the stored chunks of one file.
 * `embedding: 0` is essential - 768 doubles per chunk is ~6 KB of noise that
 * would dwarf the response and slow every list call.
 */
async function listChunks(fileId, limit = 20, offset = 0) {
  const filter = fileId ? { fileId: toObjectId(fileId) } : {};
  const [docs, total] = await Promise.all([
    db
      .chunks()
      .find(filter, { projection: { embedding: 0 } })
      .sort({ fileId: 1, chunkIndex: 1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    db.chunks().countDocuments(filter),
  ]);

  return {
    total,
    chunks: docs.map((c) => ({
      id: c._id.toString(),
      fileId: c.fileId.toString(),
      filename: c.filename,
      chunkIndex: c.chunkIndex,
      pageNumber: c.pageNumber,
      preview: c.content.slice(0, 200),
      length: c.content.length,
      createdAt: c.createdAt,
    })),
  };
}

/**
 * Delete one file and everything derived from it.
 *
 * MongoDB has no ON DELETE CASCADE, so the three deletes are explicit.
 * Order matters: remove the chunks first, because a chunk pointing at a
 * file that no longer exists is worse than a file with no chunks - the
 * orphaned chunk would still be returned by $vectorSearch.
 */
async function deleteFile(id) {
  const _id = toObjectId(id);
  const file = await db.files().findOne({ _id });
  if (!file) throw new ApiError(404, `No document with id "${id}".`);

  const { deletedCount } = await db.chunks().deleteMany({ fileId: _id });

  if (file.gridfsId) {
    await db
      .bucket()
      .delete(file.gridfsId)
      .catch((err) => console.warn(`[cleanup] GridFS delete failed: ${err.message}`));
  }

  await db.files().deleteOne({ _id });
  return { filename: file.filename, chunksDeleted: deletedCount };
}

/** Wipe the whole knowledge base - files, chunks and stored PDFs. */
async function clearAll() {
  const files = await db.files().find({}, { projection: { gridfsId: 1 } }).toArray();
  for (const file of files) {
    if (file.gridfsId) await db.bucket().delete(file.gridfsId).catch(() => {});
  }
  const chunks = await db.chunks().deleteMany({});
  const removed = await db.files().deleteMany({});
  return { filesDeleted: removed.deletedCount, chunksDeleted: chunks.deletedCount };
}

async function stats() {
  const [fileCount, chunkCount] = await Promise.all([
    db.files().countDocuments({ status: 'ready' }),
    db.chunks().countDocuments(),
  ]);
  return { files: fileCount, chunks: chunkCount };
}

/** The response shape of POST /upload, for both a fresh ingest and a duplicate. */
function toIngestDto(doc) {
  return {
    fileId: doc._id.toString(),
    file: doc.filename,
    pages: doc.pageCount,
    characters: doc.characters,
    chunksStored: doc.chunkCount,
    status: doc.status,
  };
}

/** Shape a file document for the API - internal ids become strings. */
function toFileDto(doc) {
  return {
    id: doc._id.toString(),
    filename: doc.filename,
    sizeBytes: doc.sizeBytes,
    pageCount: doc.pageCount,
    chunkCount: doc.chunkCount,
    status: doc.status,
    error: doc.error,
    createdAt: doc.createdAt,
  };
}

/** Turn a user-supplied id into an ObjectId, or fail with a clean 400. */
function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  if (!ObjectId.isValid(id)) throw new ApiError(400, `"${id}" is not a valid document id.`);
  return new ObjectId(id);
}

/**
 * The gate: refuse anything that is not a resume.
 *
 * Called from ingestPdf, NOT only from the /validate endpoint - /validate is
 * a convenience for the UI and anyone can POST straight to /upload and skip
 * it, so the real enforcement has to live here.
 */
async function assertIsResume(text, pageCount, originalName) {
  if (!resumeOnlyEnabled()) return null;

  const verdict = await classifyResume(text, { pageCount, filename: originalName });

  // A scanned resume IS a resume - this is an OCR problem, not a rejection,
  // so it gets its own message instead of "not a resume".
  if (verdict.needsOcr) {
    throw new ApiError(422, verdict.reason, { filename: originalName, needsOcr: true });
  }

  if (!verdict.isResume) {
    throw new ApiError(
      422,
      `"${originalName}" does not look like a resume. ${verdict.reason} ` +
        'Only resumes/CVs can be uploaded here.',
      {
        filename: originalName,
        isResume: false,
        confidence: verdict.confidence,
        method: verdict.method,
      }
    );
  }

  return verdict;
}

/**
 * Dry run for POST /api/documents/validate: read the PDF and judge it
 * WITHOUT storing anything. Lets the UI mark each selected file accepted or
 * rejected before the user ever presses Submit.
 *
 * Deliberately never throws for a bad document - a rejected file is a normal
 * result here, reported per file, so one bad PDF in a batch of ten does not
 * fail the whole pre-flight request.
 */
async function inspectPdf(buffer, originalName) {
  const base = { filename: originalName, sizeBytes: buffer.length };

  let extracted;
  try {
    extracted = await extractTextFromPdf(buffer);
  } catch (err) {
    return {
      ...base,
      accepted: false,
      isResume: false,
      needsOcr: false,
      confidence: 0,
      reason: err.message,
    };
  }

  const { text, pageCount } = extracted;
  const verdict = await classifyResume(text, { pageCount, filename: originalName });

  // Worth knowing before submit: re-uploading these same bytes is a no-op.
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await db.files().findOne({ sha256 }, { projection: { _id: 1, status: 1 } });

  return {
    ...base,
    pageCount,
    characters: text.length,
    accepted: resumeOnlyEnabled() ? verdict.isResume : !verdict.needsOcr,
    isResume: verdict.isResume,
    needsOcr: verdict.needsOcr,
    confidence: verdict.confidence,
    reason: verdict.reason,
    method: verdict.method,
    alreadyUploaded: Boolean(existing && existing.status === 'ready'),
    existingId: existing ? existing._id.toString() : null,
  };
}

module.exports = {
  ingestPdf,
  inspectPdf,
  listFiles,
  getFile,
  listChunks,
  deleteFile,
  clearAll,
  stats,
  openDownloadStream,
  toObjectId,
};
