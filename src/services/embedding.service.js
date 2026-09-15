const { generateEmbedding } = require('./ollama.service');
const { ApiError } = require('../middleware/error.middleware');

/** nomic-embed-text always returns 768 numbers - must match numDimensions
 *  in the Atlas vector index definition. */
const EMBEDDING_DIMENSION = 768;

/**
 * MongoDB stores an embedding as a plain BSON array of doubles, so unlike
 * pgvector there is no literal/cast step - we just validate and hand the
 * array over. A wrong length or a NaN would be silently accepted by Mongo
 * and then rejected by $vectorSearch at query time, which is much harder to
 * debug, so we check here at write time.
 *
 * @param {number[]} vector
 * @returns {number[]} the same vector, verified
 */
function assertVector(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) {
    throw new ApiError(
      500,
      `Expected a ${EMBEDDING_DIMENSION}-dimensional embedding but got ${
        Array.isArray(vector) ? vector.length : typeof vector
      }.`
    );
  }
  if (vector.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new ApiError(500, 'Embedding contains non-numeric values.');
  }
  return vector;
}

/** Embed a single string and return it ready for MongoDB. */
async function embedText(text) {
  const vector = await generateEmbedding(text);
  return { vector: assertVector(vector) };
}

/**
 * Embed many chunks.
 *
 * Ollama runs one model instance locally, so firing 500 requests at once only
 * causes queueing and memory pressure. We send a small batch at a time and
 * report progress, which keeps memory flat and makes failures easy to locate.
 *
 * @param {string[]} texts
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<number[][]>} vectors, in the same order as `texts`
 */
async function embedMany(texts, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency) || 4);
  const results = new Array(texts.length);
  let done = 0;

  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency);
    const embedded = await Promise.all(
      slice.map(async (text, offset) => {
        try {
          const { vector } = await embedText(text);
          return vector;
        } catch (err) {
          throw new ApiError(
            err.status || 502,
            `Embedding failed for chunk ${i + offset + 1}/${texts.length}: ${err.message}`
          );
        }
      })
    );
    embedded.forEach((vector, offset) => {
      results[i + offset] = vector;
    });
    done += slice.length;
    if (options.onProgress) options.onProgress(done, texts.length);
  }

  return results;
}

module.exports = { embedText, embedMany, assertVector, EMBEDDING_DIMENSION };
