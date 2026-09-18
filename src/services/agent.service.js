const { ObjectId } = require('mongodb');

const db = require('../config/db');
const ollama = require('./ollama.service');
const { GROUPS, AGENTS } = require('../agents/catalog');
const { ApiError } = require('../middleware/error.middleware');

/**
 * AI agents: form-driven prompts over the local LLM.
 *
 *   list     -> enabled agents from the `agents` collection (public fields only)
 *   run      -> validate the form -> build prompt -> llama3.2 -> store a run
 *   followUp -> brief + last few messages + new question -> llama3.2 -> append
 *
 * Agents only write text. No embeddings, no $vectorSearch: the whole context
 * is what the user typed into the form.
 */

const TEXT_MAX = 300;
const TEXTAREA_MAX = 6000;
const INPUT_TOTAL_MAX = 12000;
const HISTORY_MESSAGES = 6;
const MAX_RUN_MESSAGES = 40;

const GENERATE_OPTIONS = { temperature: 0.4, numCtx: 8192 };

/** Stored-only fields that never leave the server. */
const PRIVATE_FIELDS = ['_id', 'systemPrompt', 'enabled', 'order', 'createdAt', 'updatedAt'];

/** Only agents flagged `allowCode: true` may answer with code; a missing flag means no. */
const allowsCode = (agent) => agent.allowCode === true;

function formattingRules(agent) {
  return [
    'Formatting rules:',
    '- Use "## " for headings, "- " for bullet points, "1. " for numbered steps, and blank lines between paragraphs.',
    '- Do not use tables, bold (**), italics, or "#"/"###" headings.',
    allowsCode(agent)
      ? '- Put any code inside ``` fences, with the language after the opening fence.'
      : '- Never write code, code blocks, or programming examples. Answer in plain sentences and lists only.',
    '- Answer in the same language the user wrote in.',
  ].join('\n');
}

/**
 * Upsert every catalog agent by `id`.
 *
 * $set only touches the catalog's own fields, so extra fields added to a
 * stored agent survive a restart, and agents that exist only in MongoDB are
 * never touched.
 */
async function ensureAgents() {
  const now = new Date();
  await db.agents().bulkWrite(
    AGENTS.map((agent) => ({
      updateOne: {
        filter: { id: agent.id },
        update: {
          $set: { ...agent, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  return AGENTS.length;
}

function toPublicAgent(doc) {
  const agent = { ...doc };
  for (const key of PRIVATE_FIELDS) delete agent[key];
  return agent;
}

/** GET /api/agents */
async function listPublicAgents() {
  const docs = await db.agents().find({ enabled: { $ne: false } }).sort({ order: 1 }).toArray();
  return { groups: GROUPS, agents: docs.map(toPublicAgent) };
}

async function findAgent(agentId) {
  const agent = await db.agents().findOne({ id: String(agentId), enabled: { $ne: false } });
  if (!agent) throw new ApiError(404, `Unknown agent: ${agentId}`);
  return agent;
}

/**
 * Check one field's raw value.
 * @returns {{ value?: string|number, error?: string }} value undefined = dropped
 */
function cleanField(field, raw) {
  const label = field.label || field.name;

  let value = raw;
  if (value === undefined || value === null) value = '';
  if (typeof value === 'number') {
    value = field.type === 'number' ? value : String(value);
  } else if (typeof value === 'string') {
    value = value.trim();
  } else {
    return { error: `${label} must be text.` };
  }

  if (value === '') {
    return field.required ? { error: `${label} is required.` } : {};
  }

  switch (field.type) {
    case 'select': {
      const options = Array.isArray(field.options) ? field.options : [];
      if (!options.includes(value)) {
        return { error: `${label} must be one of: ${options.join(', ')}.` };
      }
      return { value };
    }
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) return { error: `${label} must be a number.` };
      if (field.min !== undefined && number < field.min) {
        return { error: `${label} must be at least ${field.min}.` };
      }
      if (field.max !== undefined && number > field.max) {
        return { error: `${label} must be at most ${field.max}.` };
      }
      return { value: number };
    }
    case 'textarea':
      if (value.length > TEXTAREA_MAX) {
        return { error: `${label} is too long (max ${TEXTAREA_MAX} characters).` };
      }
      return { value };
    default:
      if (value.length > TEXT_MAX) {
        return { error: `${label} is too long (max ${TEXT_MAX} characters).` };
      }
      return { value };
  }
}

/**
 * Validate a form submission against agent.fields.
 * Keys that are not fields are ignored; empty optional fields are dropped.
 * Throws one 400 listing every bad field, headed by the first problem.
 */
function validateInput(agent, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, '"input" must be an object of form fields.');
  }

  const fields = Array.isArray(agent.fields) ? agent.fields : [];
  const cleaned = {};
  const errors = {};

  for (const field of fields) {
    const raw = Object.prototype.hasOwnProperty.call(input, field.name) ? input[field.name] : undefined;
    const { value, error } = cleanField(field, raw);
    if (error) errors[field.name] = error;
    else if (value !== undefined) cleaned[field.name] = value;
  }

  const firstError = Object.values(errors)[0];
  if (firstError) throw new ApiError(400, firstError, { fields: errors });

  const total = Object.values(cleaned).reduce((sum, value) => sum + String(value).length, 0);
  if (total > INPUT_TOTAL_MAX) {
    // Pinned on the longest field - that is the one worth shortening.
    const longest = Object.keys(cleaned).reduce((a, b) =>
      String(cleaned[a]).length >= String(cleaned[b]).length ? a : b
    );
    const message = `Your input is too long (max ${INPUT_TOTAL_MAX} characters in total).`;
    throw new ApiError(400, message, { fields: { [longest]: message } });
  }

  return cleaned;
}

/** "Label: value" lines, short fields first and textareas after them. */
function buildBrief(agent, input) {
  const fields = (Array.isArray(agent.fields) ? agent.fields : []).filter(
    (field) => input[field.name] !== undefined && input[field.name] !== ''
  );
  const ordered = [
    ...fields.filter((field) => field.type !== 'textarea'),
    ...fields.filter((field) => field.type === 'textarea'),
  ];
  return ordered.map((field) => `${field.label || field.name}: ${input[field.name]}`).join('\n');
}

/**
 * One prompt string (generateAnswer takes a single prompt).
 * `history` and `question` are only passed for a follow-up.
 */
function buildPrompt(agent, input, { history, question } = {}) {
  const parts = [agent.systemPrompt || '', formattingRules(agent), `User's brief:\n${buildBrief(agent, input)}`];

  if (question !== undefined) {
    const lines = (history || []).map(
      (message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`
    );
    parts.push(`Conversation so far:\n${lines.join('\n\n')}`);
    parts.push(`New question: ${question}`);
  }

  parts.push('Answer:');
  return parts.filter(Boolean).join('\n\n');
}

/** Strip ** and __ from prose, leaving `inline code` untouched. */
function stripEmphasis(line) {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/\*\*|__/g, '')))
    .join('');
}

/**
 * Pull the model's markdown into the small subset the frontend renders.
 * Nothing inside ``` fences is changed - and unless the agent allows code,
 * every fenced block (an unclosed trailing one included) is removed whole.
 */
function normalizeAnswer(text, { allowCode = false } = {}) {
  const out = [];
  let inFence = false;
  let blankRun = 0;

  for (const rawLine of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      if (allowCode) {
        out.push(rawLine);
      } else if (inFence) {
        // Drop the blank lines before a removed block; the ones after it
        // then separate the surrounding paragraphs on their own.
        while (out.length && out[out.length - 1] === '') out.pop();
      }
      blankRun = 0;
      continue;
    }
    if (inFence) {
      if (allowCode) out.push(rawLine);
      continue;
    }

    if (!rawLine.trim()) {
      // Collapse any run of 3+ blank lines into a single blank line.
      blankRun += 1;
      out.push('');
      continue;
    }
    if (blankRun >= 3) out.splice(out.length - blankRun + 1);
    blankRun = 0;

    let line = rawLine
      .replace(/^\s*#{1,6}\s+/, '## ')
      .replace(/^(\s*)[*•]\s+/, '$1- ');
    line = stripEmphasis(line);
    out.push(line);
  }
  if (blankRun >= 3) out.splice(out.length - blankRun + 1);

  const normalized = out.join('\n').trim();
  if (!normalized) throw new ApiError(502, 'The model returned an empty answer.');
  return normalized;
}

/** POST /api/agents/:agentId/run */
async function runAgent(agentId, rawInput, userId) {
  const started = Date.now();
  const agent = await findAgent(agentId);
  const input = validateInput(agent, rawInput);

  const answer = await ollama.generateAnswer(buildPrompt(agent, input), GENERATE_OPTIONS);
  const text = normalizeAnswer(answer, { allowCode: allowsCode(agent) });

  const now = new Date();
  const tookMs = Date.now() - started;
  const { insertedId } = await db.agentRuns().insertOne({
    userId,
    agentId: agent.id,
    input,
    messages: [{ role: 'assistant', text, at: now }],
    model: ollama.LLM_MODEL(),
    createdAt: now,
    updatedAt: now,
    tookMs,
  });

  return { runId: insertedId.toHexString(), text, tookMs };
}

/** POST /api/agents/runs/:runId/messages */
async function followUp(runId, question, userId) {
  const started = Date.now();
  if (!ObjectId.isValid(String(runId)) || !/^[0-9a-f]{24}$/i.test(String(runId))) {
    throw new ApiError(400, `"${runId}" is not a valid run id.`);
  }
  const _id = new ObjectId(String(runId));

  // Scoped to the caller: someone else's run is indistinguishable from none.
  const run = await db.agentRuns().findOne({ _id, userId });
  if (!run) throw new ApiError(404, 'Run not found.');

  const messages = Array.isArray(run.messages) ? run.messages : [];
  if (messages.length >= MAX_RUN_MESSAGES) {
    throw new ApiError(409, 'This conversation is too long. Start a new request.');
  }

  const agent = await findAgent(run.agentId);
  const prompt = buildPrompt(agent, run.input || {}, {
    history: messages.slice(-HISTORY_MESSAGES),
    question,
  });

  const answer = await ollama.generateAnswer(prompt, GENERATE_OPTIONS);
  const text = normalizeAnswer(answer, { allowCode: allowsCode(agent) });

  // Only written once the model has answered, so a failed call leaves no
  // dangling unanswered question in the history.
  const now = new Date();
  await db.agentRuns().updateOne(
    { _id, userId },
    {
      $push: {
        messages: {
          $each: [
            { role: 'user', text: question, at: now },
            { role: 'assistant', text, at: now },
          ],
        },
      },
      $set: { updatedAt: now },
    }
  );

  return { text, tookMs: Date.now() - started };
}

module.exports = {
  ensureAgents,
  listPublicAgents,
  validateInput,
  buildPrompt,
  normalizeAnswer,
  runAgent,
  followUp,
};
