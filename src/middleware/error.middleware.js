const multer = require('multer');

/**
 * An error we raised on purpose, carrying the HTTP status to return.
 * Anything that is NOT an ApiError is treated as an unexpected 500.
 */
class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/** 404 handler - runs when no route matched. */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

/**
 * Centralized error handler. Express calls this for anything passed to
 * next(err) or thrown inside an async route wrapped with asyncHandler().
 */
// eslint-disable-next-line no-unused-vars -- Express needs all 4 args
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = err.message || 'Internal server error';

  // --- Upload errors from multer ---
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = `File too large. Maximum allowed size is ${process.env.MAX_UPLOAD_MB || 20} MB.`;
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Unexpected upload field. Send the PDFs in a field named "files".';
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      message = `Too many files. Maximum is ${process.env.MAX_UPLOAD_FILES || 10} per upload.`;
    }
  }

  // --- MongoDB problems ---
  // Server unreachable / DNS failure for the SRV record / auth rejected.
  if (
    err.name === 'MongoServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND'
  ) {
    status = 503;
    message =
      'MongoDB is unavailable. Check MONGODB_URI and that this machine\'s IP is ' +
      `allowed in the Atlas Network Access list. (${err.message})`;
  } else if (err.name === 'MongoServerError' && err.code === 11000) {
    // Unique index violation - in this app that means "already ingested".
    status = 409;
    message = 'That document already exists.';
  }

  // An ApiError is a condition we decided to report, so it gets one readable
  // line however severe its status is. A stack trace is only useful for the
  // errors nobody planned for - and a deliberate 503 (database still
  // connecting) would otherwise dump one on every single request.
  const deliberate = err instanceof ApiError;
  if (status >= 500 && !deliberate) {
    console.error('[error]', err);
  } else {
    console.warn('[warn]', message);
  }

  const body = { success: false, error: message };
  if (err.details) body.details = err.details;
  // Stack traces are for developers only - never leak them in production.
  if (process.env.NODE_ENV !== 'production' && status >= 500 && !deliberate) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}

/**
 * Wraps an async route handler so a rejected promise reaches errorHandler
 * instead of hanging the request.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { ApiError, errorHandler, notFoundHandler, asyncHandler };
