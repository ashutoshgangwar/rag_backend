const { ApiError } = require('../middleware/error.middleware');

/**
 * Thin client for the local Ollama HTTP API.
 * No API key, no cloud, nothing leaves this machine.
 *
 *   POST /api/generate  -> text completion  (llama3.2:latest)
 *   POST /api/embed     -> embedding vector (nomic-embed-text:latest)
 */

const BASE_URL = () => (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const LLM_MODEL = () => process.env.OLLAMA_LLM_MODEL || 'llama3.2:latest';
const EMBED_MODEL = () => process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text:latest';

/**
 * One place for every Ollama HTTP call: adds a timeout and turns any
 * connection/HTTP problem into a clean 503 ApiError.
 */
async function callOllama(path, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${BASE_URL()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError(504, `Ollama timed out after ${timeoutMs / 1000}s on ${path}.`);
    }
    throw new ApiError(
      503,
      `Cannot reach Ollama at ${BASE_URL()}. Is it running? (${err.message})`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 404 from Ollama almost always means "model not pulled".
    const hint = response.status === 404
      ? ' The model may not be pulled yet - run: ollama pull <model>'
      : '';
    throw new ApiError(502, `Ollama returned ${response.status} for ${path}: ${text}${hint}`);
  }

  return response.json();
}

/**
 * Ask llama3.2 to produce an answer.
 * stream:false => Ollama replies with one complete JSON object.
 *
 * @param {string} prompt
 * @param {{ temperature?: number }} [options]
 * @returns {Promise<string>} only the generated text
 */
async function generateAnswer(prompt, options = {}) {
  const data = await callOllama('/api/generate', {
    model: LLM_MODEL(),
    prompt,
    stream: false,
    options: {
      // Low temperature keeps the model close to the retrieved context
      // instead of inventing things.
      temperature: options.temperature ?? 0.2,
    },
  });

  const answer = (data.response || '').trim();
  if (!answer) throw new ApiError(502, 'The LLM returned an empty response.');
  return answer;
}

/**
 * Turn one piece of text into a 768-dimensional vector.
 *
 * @param {string} text
 * @returns {Promise<number[]>} the embedding vector
 */
async function generateEmbedding(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ApiError(400, 'Cannot embed empty text.');
  }

  const data = await callOllama('/api/embed', {
    model: EMBED_MODEL(),
    input: text,
  });

  const vector = Array.isArray(data.embeddings) ? data.embeddings[0] : null;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new ApiError(502, 'Ollama did not return an embedding vector.');
  }
  return vector;
}

/** Health check: is the Ollama daemon answering, and are our models present? */
async function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${BASE_URL()}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    return {
      reachable: true,
      models: names,
      llmAvailable: names.includes(LLM_MODEL()),
      embeddingAvailable: names.includes(EMBED_MODEL()),
    };
  } catch (err) {
    return { reachable: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateAnswer, generateEmbedding, checkHealth, LLM_MODEL, EMBED_MODEL };
