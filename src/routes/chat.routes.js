const express = require('express');
const controller = require('../controllers/chat.controller');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.post('/', asyncHandler(controller.chat));

module.exports = router;
