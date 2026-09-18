const subscriptionService = require('../services/subscription.service');

/** GET /api/admin/plans - every plan, inactive ones included. */
async function listPlans(req, res) {
  const plans = await subscriptionService.listPlans({ includeInactive: true });
  res.json({ success: true, plans });
}

/** POST /api/admin/plans - body: { id, name, interval, intervalCount?, amount, currency?, description?, order? } */
async function createPlan(req, res) {
  const plan = await subscriptionService.createPlan(req.body);
  res.status(201).json({ success: true, plan });
}

/** PATCH /api/admin/plans/:planId - any of: name, description, amount, currency, interval, intervalCount, active, order */
async function updatePlan(req, res) {
  const plan = await subscriptionService.updatePlan(req.params.planId, req.body);
  res.json({ success: true, plan });
}

/** GET /api/admin/settings */
async function getSettings(req, res) {
  const settings = await subscriptionService.getBillingSettings();
  res.json({ success: true, settings });
}

/** PATCH /api/admin/settings - body: { freePromptLimit } */
async function updateSettings(req, res) {
  const settings = await subscriptionService.updateBillingSettings(req.body);
  res.json({ success: true, settings });
}

module.exports = { listPlans, createPlan, updatePlan, getSettings, updateSettings };
