const express = require('express');

const controller = require('../controllers/admin.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/plans', asyncHandler(controller.listPlans));
router.post('/plans', asyncHandler(controller.createPlan));
router.patch('/plans/:planId', asyncHandler(controller.updatePlan));
router.get('/settings', asyncHandler(controller.getSettings));
router.patch('/settings', asyncHandler(controller.updateSettings));

module.exports = router;
