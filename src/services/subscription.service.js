const { ObjectId } = require('mongodb');

const db = require('../config/db');
const { ApiError } = require('../middleware/error.middleware');

/**
 * Plans, subscriptions and the free-prompt quota.
 *
 *   plans         -> one document per plan (daily / monthly / yearly); the
 *                    amount, currency and duration are read from MongoDB on
 *                    every request, so editing a plan document takes effect
 *                    immediately, with no restart.
 *   settings      -> { _id: 'billing', freePromptLimit } - the free tier size.
 *   subscriptions -> one document per purchase, with startsAt / endsAt.
 *
 * A prompt (a chat question, an agent run or a follow-up) is allowed when the
 * user has a subscription whose endsAt is in the future, OR has used fewer
 * than `freePromptLimit` prompts in total.
 */

const BILLING_SETTINGS_ID = 'billing';
const INTERVALS = ['day', 'month', 'year'];

/** Seeded once. Later edits in MongoDB are never overwritten. */
const DEFAULT_FREE_PROMPT_LIMIT = 5;
const DEFAULT_PLANS = [
  { id: 'daily', name: 'Daily', interval: 'day', intervalCount: 1, amount: 49, currency: 'INR', order: 1 },
  { id: 'monthly', name: 'Monthly', interval: 'month', intervalCount: 1, amount: 499, currency: 'INR', order: 2 },
  { id: 'yearly', name: 'Yearly', interval: 'year', intervalCount: 1, amount: 4999, currency: 'INR', order: 3 },
];

/**
 * Insert the default plans and settings if they are missing.
 *
 * Everything goes through $setOnInsert, so a price changed in MongoDB (or via
 * the admin API) survives every restart - the defaults only fill an empty DB.
 */
async function ensureBillingDefaults() {
  const now = new Date();
  await db.plans().bulkWrite(
    DEFAULT_PLANS.map((plan) => ({
      updateOne: {
        filter: { id: plan.id },
        update: { $setOnInsert: { ...plan, active: true, createdAt: now, updatedAt: now } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  await db.settings().updateOne(
    { _id: BILLING_SETTINGS_ID },
    { $setOnInsert: { freePromptLimit: DEFAULT_FREE_PROMPT_LIMIT, createdAt: now, updatedAt: now } },
    { upsert: true }
  );
  return DEFAULT_PLANS.length;
}

// ---------------------------------------------------------------- settings

async function getBillingSettings() {
  const doc = await db.settings().findOne({ _id: BILLING_SETTINGS_ID });
  const limit = Number(doc?.freePromptLimit);
  return {
    freePromptLimit: Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_FREE_PROMPT_LIMIT,
  };
}

async function updateBillingSettings(payload = {}) {
  const { freePromptLimit } = payload;
  if (!Number.isInteger(freePromptLimit) || freePromptLimit < 0) {
    throw new ApiError(400, '"freePromptLimit" must be a whole number, 0 or more.');
  }
  await db.settings().updateOne(
    { _id: BILLING_SETTINGS_ID },
    { $set: { freePromptLimit, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return getBillingSettings();
}

// ------------------------------------------------------------------- plans

function toPublicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || '',
    interval: plan.interval,
    intervalCount: plan.intervalCount || 1,
    amount: plan.amount,
    currency: plan.currency,
    active: plan.active !== false,
  };
}

/** GET /api/subscriptions/plans - active plans only, cheapest period first. */
async function listPlans({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { active: { $ne: false } };
  const docs = await db.plans().find(filter).sort({ order: 1, amount: 1 }).toArray();
  return docs.map(toPublicPlan);
}

async function findActivePlan(planId) {
  if (typeof planId !== 'string' || !planId.trim()) {
    throw new ApiError(400, 'A "planId" string is required.');
  }
  const plan = await db.plans().findOne({ id: planId.trim(), active: { $ne: false } });
  if (!plan) throw new ApiError(404, `Unknown or inactive plan: ${planId}`);
  return plan;
}

/**
 * Shared by create and update. `partial` skips the required-field checks so
 * a PATCH can change just the amount.
 */
function validatePlanFields(payload = {}, { partial = false } = {}) {
  const out = {};
  const has = (key) => payload[key] !== undefined;

  if (has('name') || !partial) {
    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 60) {
      throw new ApiError(400, '"name" is required (max 60 characters).');
    }
    out.name = payload.name.trim();
  }
  if (has('description')) {
    if (typeof payload.description !== 'string' || payload.description.length > 300) {
      throw new ApiError(400, '"description" must be text (max 300 characters).');
    }
    out.description = payload.description.trim();
  }
  if (has('amount') || !partial) {
    if (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount < 0) {
      throw new ApiError(400, '"amount" must be a number, 0 or more.');
    }
    // Money is kept to 2 decimal places, in the currency's major unit.
    out.amount = Math.round(payload.amount * 100) / 100;
  }
  if (has('currency') || !partial) {
    const currency = String(payload.currency ?? 'INR').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(400, '"currency" must be a 3-letter code, e.g. INR.');
    out.currency = currency;
  }
  if (has('interval') || !partial) {
    if (!INTERVALS.includes(payload.interval)) {
      throw new ApiError(400, `"interval" must be one of: ${INTERVALS.join(', ')}.`);
    }
    out.interval = payload.interval;
  }
  if (has('intervalCount') || !partial) {
    const count = payload.intervalCount ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 36) {
      throw new ApiError(400, '"intervalCount" must be a whole number from 1 to 36.');
    }
    out.intervalCount = count;
  }
  if (has('active')) {
    if (typeof payload.active !== 'boolean') throw new ApiError(400, '"active" must be true or false.');
    out.active = payload.active;
  }
  if (has('order')) {
    if (!Number.isInteger(payload.order)) throw new ApiError(400, '"order" must be a whole number.');
    out.order = payload.order;
  }
  return out;
}

/** POST /api/admin/plans */
async function createPlan(payload = {}) {
  const id = typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : '';
  if (!/^[a-z0-9-]{2,40}$/.test(id)) {
    throw new ApiError(400, '"id" is required: 2-40 lowercase letters, digits or dashes, e.g. "quarterly".');
  }
  const fields = validatePlanFields(payload);
  const now = new Date();
  const doc = { id, active: true, order: 99, ...fields, createdAt: now, updatedAt: now };
  try {
    await db.plans().insertOne(doc);
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, `A plan with id "${id}" already exists.`);
    throw err;
  }
  return toPublicPlan(doc);
}

/** PATCH /api/admin/plans/:planId - change the amount, name, duration, or deactivate. */
async function updatePlan(planId, payload = {}) {
  const fields = validatePlanFields(payload, { partial: true });
  if (Object.keys(fields).length === 0) throw new ApiError(400, 'Nothing to update.');

  const updated = await db.plans().findOneAndUpdate(
    { id: String(planId) },
    { $set: { ...fields, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!updated) throw new ApiError(404, `Unknown plan: ${planId}`);
  return toPublicPlan(updated);
}

// ----------------------------------------------------------- subscriptions

/**
 * `start` + N days/months/years. A month is a calendar month, clamped to the
 * last day - so Jan 31 + 1 month is Feb 28/29, not Mar 3.
 */
function addInterval(start, interval, count = 1) {
  const end = new Date(start);
  if (interval === 'day') {
    end.setUTCDate(end.getUTCDate() + count);
    return end;
  }
  const months = interval === 'year' ? 12 * count : count;
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

function toPublicSubscription(sub) {
  return {
    id: sub._id.toString(),
    planId: sub.planId,
    planName: sub.planName,
    interval: sub.interval,
    intervalCount: sub.intervalCount,
    amount: sub.amount,
    currency: sub.currency,
    status: sub.status,
    startsAt: sub.startsAt,
    endsAt: sub.endsAt,
    createdAt: sub.createdAt,
  };
}

/** The subscription covering this instant, if any. */
async function findActiveSubscription(userId, now = new Date()) {
  return db.subscriptions().findOne(
    { userId, status: 'active', startsAt: { $lte: now }, endsAt: { $gt: now } },
    { sort: { endsAt: -1 } }
  );
}

/**
 * POST /api/subscriptions/subscribe
 *
 * Buying while already subscribed stacks: the new period starts when the
 * latest one ends, so no paid time is lost.
 *
 * The price is copied onto the subscription, so a later change to the plan's
 * amount never rewrites what an existing subscriber paid.
 *
 * NOTE: no payment gateway is wired in yet - calling this activates the plan
 * straight away. Put the gateway's order/verify step in front of it before
 * going live.
 */
async function subscribe(userId, planId) {
  const plan = await findActivePlan(planId);
  const now = new Date();

  const latest = await db.subscriptions().findOne(
    { userId, status: 'active', endsAt: { $gt: now } },
    { sort: { endsAt: -1 } }
  );
  const startsAt = latest ? latest.endsAt : now;
  const intervalCount = plan.intervalCount || 1;

  const doc = {
    userId,
    planId: plan.id,
    planName: plan.name,
    interval: plan.interval,
    intervalCount,
    amount: plan.amount,
    currency: plan.currency,
    status: 'active',
    startsAt,
    endsAt: addInterval(startsAt, plan.interval, intervalCount),
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await db.subscriptions().insertOne(doc);
  return toPublicSubscription({ ...doc, _id: insertedId });
}

/** GET /api/subscriptions/history */
async function listSubscriptions(userId) {
  const docs = await db.subscriptions().find({ userId }).sort({ createdAt: -1 }).limit(100).toArray();
  return docs.map(toPublicSubscription);
}

/** GET /api/subscriptions/me - everything the UI needs for a paywall / badge. */
async function getStatus(userId) {
  const [user, active, { freePromptLimit }] = await Promise.all([
    db.users().findOne({ _id: new ObjectId(String(userId)) }, { projection: { promptsUsed: 1 } }),
    findActiveSubscription(userId),
    getBillingSettings(),
  ]);
  const promptsUsed = user?.promptsUsed || 0;
  const freePromptsRemaining = Math.max(0, freePromptLimit - promptsUsed);

  return {
    subscribed: Boolean(active),
    subscription: active ? toPublicSubscription(active) : null,
    freePromptLimit,
    promptsUsed,
    freePromptsRemaining,
    canPrompt: Boolean(active) || freePromptsRemaining > 0,
  };
}

// ------------------------------------------------------------ prompt quota

/**
 * Reserve one prompt for this user, or throw 402.
 *
 * The free-tier path is a single conditional $inc, so two requests racing on
 * the 5th prompt cannot both get through. Returns a `release` function that
 * gives the prompt back - called when the request fails, so an error from the
 * model never costs the user one of their free prompts.
 */
async function consumePrompt(userId) {
  const _id = new ObjectId(String(userId));

  if (await findActiveSubscription(userId)) {
    await db.users().updateOne({ _id }, { $inc: { promptsUsed: 1 } });
    return { subscribed: true, release: () => releasePrompt(_id) };
  }

  const { freePromptLimit } = await getBillingSettings();
  const reserved = await db.users().findOneAndUpdate(
    {
      _id,
      $or: [{ promptsUsed: { $exists: false } }, { promptsUsed: { $lt: freePromptLimit } }],
    },
    { $inc: { promptsUsed: 1 } },
    { returnDocument: 'after', projection: { promptsUsed: 1 } }
  );

  if (!reserved) {
    const plans = await listPlans();
    throw new ApiError(
      402,
      `You have used all ${freePromptLimit} free prompts. Subscribe to a plan to continue.`,
      { code: 'SUBSCRIPTION_REQUIRED', freePromptLimit, plans }
    );
  }

  return {
    subscribed: false,
    freePromptsRemaining: Math.max(0, freePromptLimit - reserved.promptsUsed),
    release: () => releasePrompt(_id),
  };
}

async function releasePrompt(_id) {
  await db.users().updateOne({ _id, promptsUsed: { $gt: 0 } }, { $inc: { promptsUsed: -1 } });
}

module.exports = {
  INTERVALS,
  ensureBillingDefaults,
  getBillingSettings,
  updateBillingSettings,
  listPlans,
  createPlan,
  updatePlan,
  addInterval,
  subscribe,
  listSubscriptions,
  getStatus,
  consumePrompt,
};
