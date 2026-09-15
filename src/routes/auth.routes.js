const express = require('express');

const controller = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.post('/signup', asyncHandler(controller.signup));
router.post('/login', asyncHandler(controller.login));
router.get('/me', requireAuth, asyncHandler(controller.me));
router.post('/logout', requireAuth, asyncHandler(controller.logout));

module.exports = router;
