const express = require('express');

const controller = require('../controllers/agent.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePromptQuota } = require('../middleware/subscription.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.get('/', requireAuth, asyncHandler(controller.list));
router.post('/:agentId/run', requireAuth, requirePromptQuota, asyncHandler(controller.run));
router.post('/runs/:runId/messages', requireAuth, requirePromptQuota, asyncHandler(controller.followUp));

module.exports = router;
