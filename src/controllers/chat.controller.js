const ragService = require('../services/rag.service');
const { ApiError } = require('../middleware/error.middleware');

const MAX_QUESTION_LENGTH = 1000;

/** POST /api/chat - answer a question from the indexed documents. */
async function chat(req, res) {
  const { question, topK, fileIds } = req.body || {};

  // --- input validation ---
  if (typeof question !== 'string' || !question.trim()) {
    throw new ApiError(400, 'A non-empty "question" string is required.');
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ApiError(400, `Question is too long (max ${MAX_QUESTION_LENGTH} characters).`);
  }
  // Optional: restrict the search to specific PDFs.
  if (fileIds !== undefined && !Array.isArray(fileIds)) {
    throw new ApiError(400, '"fileIds" must be an array of document ids.');
  }

  const trimmed = question.trim();
  const started = Date.now();
  const result = await ragService.answerQuestion(trimmed, { topK, fileIds });

  res.json({
    success: true,
    question: trimmed,
    answer: result.answer,
    // Sources let you verify the answer instead of trusting it.
    // The embedding vectors themselves are deliberately not returned.
    sources: result.sources,
    ...(result.note ? { note: result.note } : {}),
    tookMs: Date.now() - started,
    usage: req.promptUsage,
  });
}

module.exports = { chat };
