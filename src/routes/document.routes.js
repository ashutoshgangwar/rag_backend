const path = require('path');
const express = require('express');
const multer = require('multer');

const controller = require('../controllers/document.controller');
const { asyncHandler, ApiError } = require('../middleware/error.middleware');

const router = express.Router();

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 20;
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES) || 10;

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
});

/**
 * Both field names are accepted: "files" for multi-file uploads, and "file"
 * so the original single-file clients keep working unchanged.
 */
const acceptPdfs = upload.fields([
  { name: 'files', maxCount: MAX_UPLOAD_FILES },
  { name: 'file', maxCount: MAX_UPLOAD_FILES },
]);

/**
 * PDFs only - checked by both MIME type and extension.
 *
 * This is the cheap gate. It proves the bytes are a PDF but says nothing
 * about WHAT the PDF is; "is this actually a resume?" needs the extracted
 * text and is enforced in document.service.ingestPdf.
 */
function fileFilter(req, file, cb) {
  const isPdfMime = file.mimetype === 'application/pdf';
  const isPdfExt = path.extname(file.originalname).toLowerCase() === '.pdf';
  if (isPdfMime && isPdfExt) return cb(null, true);
  cb(new ApiError(400, `"${file.originalname}" is not a PDF. Only .pdf resumes are allowed.`));
}

// Pre-flight for the UI: judge the picked files without storing anything, so
// Submit can stay disabled until every one of them is a resume.
router.post('/validate', acceptPdfs, asyncHandler(controller.validateDocuments));
router.post('/upload', acceptPdfs, asyncHandler(controller.uploadDocument));
router.get('/', asyncHandler(controller.listDocuments));
router.get('/:id', asyncHandler(controller.getDocument));
router.get('/:id/chunks', asyncHandler(controller.listDocumentChunks));
router.get('/:id/download', asyncHandler(controller.downloadDocument));
router.delete('/:id', asyncHandler(controller.deleteDocument));
router.delete('/', asyncHandler(controller.clearDocuments));

module.exports = router;
