const subscriptionService = require('../services/subscription.service');

/** GET /api/subscriptions/plans - public: the plans a user can buy. */
async function listPlans(req, res) {
  const [plans, { freePromptLimit }] = await Promise.all([
    subscriptionService.listPlans(),
    subscriptionService.getBillingSettings(),
  ]);
  res.json({ success: true, freePromptLimit, plans });
}

/** GET /api/subscriptions/me - quota and current subscription. */
async function me(req, res) {
  const status = await subscriptionService.getStatus(req.userId);
  res.json({ success: true, ...status });
}

/** POST /api/subscriptions/subscribe - body: { planId } */
async function subscribe(req, res) {
  const subscription = await subscriptionService.subscribe(req.userId, (req.body || {}).planId);
  res.status(201).json({
    success: true,
    message: `Subscribed to ${subscription.planName} until ${subscription.endsAt.toISOString()}.`,
    subscription,
  });
}

/** GET /api/subscriptions/history - every subscription this user bought. */
async function history(req, res) {
  const subscriptions = await subscriptionService.listSubscriptions(req.userId);
  res.json({ success: true, subscriptions });
}

module.exports = { listPlans, me, subscribe, history };
