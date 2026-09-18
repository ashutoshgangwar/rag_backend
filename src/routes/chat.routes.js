const express = require('express');
const controller = require('../controllers/chat.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePromptQuota } = require('../middleware/subscription.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

// Signed-in only: every question counts against the free prompts or needs a plan.
router.post('/', requireAuth, requirePromptQuota, asyncHandler(controller.chat));

module.exports = router;
