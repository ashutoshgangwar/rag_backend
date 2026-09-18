const express = require('express');

const controller = require('../controllers/subscription.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.get('/plans', asyncHandler(controller.listPlans));
router.get('/me', requireAuth, asyncHandler(controller.me));
router.post('/subscribe', requireAuth, asyncHandler(controller.subscribe));
router.get('/history', requireAuth, asyncHandler(controller.history));

module.exports = router;
