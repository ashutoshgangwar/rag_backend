const express = require('express');

const controller = require('../controllers/agent.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.get('/', requireAuth, asyncHandler(controller.list));
router.post('/:agentId/run', requireAuth, asyncHandler(controller.run));
router.post('/runs/:runId/messages', requireAuth, asyncHandler(controller.followUp));

module.exports = router;
