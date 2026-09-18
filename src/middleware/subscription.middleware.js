const subscriptionService = require('../services/subscription.service');

/**
 * Prompt meter. Put it AFTER requireAuth on every route that sends a prompt
 * to the model:
 *
 *   router.post('/', requireAuth, requirePromptQuota, asyncHandler(controller.chat))
 *
 * It reserves one prompt up front (402 when the free prompts are used up and
 * there is no active subscription), and hands it back if the request ends in
 * an error - a validation 400 or a failed model call is not a used prompt.
 */
async function requirePromptQuota(req, res, next) {
  try {
    const usage = await subscriptionService.consumePrompt(req.userId);
    req.promptUsage = { subscribed: usage.subscribed, freePromptsRemaining: usage.freePromptsRemaining };

    res.on('finish', () => {
      if (res.statusCode >= 400) {
        usage.release().catch((err) => console.warn('[warn] could not release prompt:', err.message));
      }
    });
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requirePromptQuota };
