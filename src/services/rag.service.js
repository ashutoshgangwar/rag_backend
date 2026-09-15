const db = require('../config/db');
const { embedText } = require('./embedding.service');
const { generateAnswer } = require('./ollama.service');
const { toObjectId } = require('./document.service');

/**
 * The RETRIEVAL half of RAG.
 *
 *   question -> embed -> Atlas $vectorSearch -> top K chunks
 *            -> build context -> prompt llama3.2 -> answer
 */

const FALLBACK = "I don't know based on the provided documents.";

/**
 * Find the chunks whose meaning is closest to the question.
 *
 * $vectorSearch MUST be the first stage of the pipeline - you cannot $match
 * ahead of it. To narrow the search to particular files, use the stage's own
 * `filter`, which works only because `fileId` is declared as a filter field
 * in the index definition (see config/db.js).
 *
 * `numCandidates` is how many approximate neighbours Atlas considers before
 * ranking down to `limit`. Too low and recall suffers; ~10-20x limit is the
 * usual sweet spot.
 *
 * The returned `vectorSearchScore` for cosine similarity is normalised by
 * Atlas to (1 + cosine) / 2, so it lands in [0, 1] where 1 is identical.
 * That is NOT the same scale as pgvector's `1 - distance`.
 */
async function searchSimilarChunks(queryVector, topK = 5, fileIds = []) {
  const vectorStage = {
    index: db.VECTOR_INDEX_NAME,
    path: 'embedding',
    queryVector,
    numCandidates: Math.min(topK * 20, 1000),
    limit: topK,
  };

  if (fileIds.length > 0) {
    vectorStage.filter = { fileId: { $in: fileIds.map(toObjectId) } };
  }

  const rows = await db
    .chunks()
    .aggregate([
      { $vectorSearch: vectorStage },
      {
        $project: {
          // `embedding` is deliberately absent - we never ship 768 doubles back.
          content: 1,
          fileId: 1,
          filename: 1,
          pageNumber: 1,
          chunkIndex: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ])
    .toArray();

  return rows.map((row) => ({
    id: row._id.toString(),
    fileId: row.fileId.toString(),
    filename: row.filename,
    pageNumber: row.pageNumber,
    content: row.content,
    similarity: Number(Number(row.score).toFixed(4)),
  }));
}

/**
 * Glue the retrieved chunks into one numbered context block.
 * Naming the file and page in each header is what lets the model - and the
 * reader - point at where an answer came from.
 */
function buildContext(chunks) {
  return chunks
    .map((c, i) => {
      const page = c.pageNumber ? `, page ${c.pageNumber}` : '';
      return `[Source ${i + 1} | ${c.filename || 'document'}${page}]\n${c.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * A strict RAG prompt. The instructions matter as much as the retrieval:
 * without them a small model will happily answer from its own training data,
 * which is exactly what RAG is supposed to prevent.
 */
function buildPrompt(context, question) {
  return `You are a helpful AI assistant.

Answer the user's question using ONLY the provided context.

If the answer cannot be found in the context, say:
"${FALLBACK}"

Cite the source number you used, like [Source 2].
Do not invent information.

Context:
${context}

Question:
${question}

Answer:`;
}

/**
 * Full question-answering pipeline.
 *
 * @param {string} question
 * @param {{ topK?: number, fileIds?: string[] }} [options]
 */
async function answerQuestion(question, options = {}) {
  const topK = Math.min(Math.max(Number(options.topK) || Number(process.env.TOP_K) || 5, 1), 20);
  const fileIds = Array.isArray(options.fileIds) ? options.fileIds : [];

  // 1. Question -> vector, using the SAME embedding model as ingestion.
  //    Using a different model here would put the question in a different
  //    vector space and every distance would be meaningless.
  const { vector } = await embedText(question);

  // 2. Vector -> nearest chunks
  const chunks = await searchSimilarChunks(vector, topK, fileIds);

  // 3. Nothing indexed yet? Say so instead of hallucinating.
  if (chunks.length === 0) {
    const fileCount = await db.files().countDocuments();
    return {
      answer: FALLBACK,
      sources: [],
      note:
        fileCount === 0
          ? 'No documents have been uploaded yet.'
          : 'No chunk matched this question.',
    };
  }

  // 4. Chunks -> context -> prompt -> llama3.2
  const context = buildContext(chunks);
  const prompt = buildPrompt(context, question);
  const answer = await generateAnswer(prompt);

  return { answer, sources: chunks };
}

module.exports = { answerQuestion, searchSimilarChunks, buildContext, buildPrompt, FALLBACK };
