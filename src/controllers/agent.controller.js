const agentService = require('../services/agent.service');
const { ApiError } = require('../middleware/error.middleware');

// Same limit as POST /api/chat.
const MAX_QUESTION_LENGTH = 1000;

/** GET /api/agents - the agent catalog, without server-only fields. */
async function list(req, res) {
  const { groups, agents } = await agentService.listPublicAgents();
  res.json({ success: true, groups, agents });
}

/** POST /api/agents/:agentId/run - fill in an agent's form, get an answer. */
async function run(req, res) {
  const { input } = req.body || {};
  const result = await agentService.runAgent(req.params.agentId, input, req.userId);

  res.json({
    success: true,
    runId: result.runId,
    result: { kind: 'answer', text: result.text },
    tookMs: result.tookMs,
    usage: req.promptUsage,
  });
}

/** POST /api/agents/runs/:runId/messages - ask a follow-up on an earlier run. */
async function followUp(req, res) {
  const { question } = req.body || {};

  // --- input validation ---
  if (typeof question !== 'string' || !question.trim()) {
    throw new ApiError(400, 'A non-empty "question" string is required.');
  }
  const trimmed = question.trim();
  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new ApiError(400, `Question is too long (max ${MAX_QUESTION_LENGTH} characters).`);
  }

  const result = await agentService.followUp(req.params.runId, trimmed, req.userId);
  res.json({ success: true, text: result.text, tookMs: result.tookMs, usage: req.promptUsage });
}

module.exports = { list, run, followUp };
