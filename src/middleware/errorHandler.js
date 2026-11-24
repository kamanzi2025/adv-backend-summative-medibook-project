// The only place where errors become HTTP responses, so every error has the
// same shape: { error: { status, message, details? } }
const AppError = require('../utils/AppError');
const { mapDbError } = require('../utils/dbErrorMap');
const { HTTP_STATUS } = require('../config/constants');

const { INTERNAL_ERROR } = HTTP_STATUS;

function toAppError(err) {
  if (err instanceof AppError) return err;

  // Bad JSON or an oversized body, reported by express.json().
  if (err.type === 'entity.parse.failed') {
    return AppError.badRequest('Malformed JSON in request body', [
      { field: 'body', message: 'is not valid JSON' },
    ]);
  }
  if (err.type === 'entity.too.large') {
    return new AppError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'Request body is too large');
  }

  const mapped = mapDbError(err);
  if (mapped) return new AppError(mapped.status, mapped.message, mapped.details);

  // Other 4xx errors that Express raises itself, like an unsupported charset.
  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= HTTP_STATUS.BAD_REQUEST && status < INTERNAL_ERROR) {
    return new AppError(status, err.expose ? err.message : 'Bad request');
  }

  return new AppError(INTERNAL_ERROR, 'Internal server error');
}

// Express only treats a middleware as an error handler if it takes 4 arguments,
// so `next` stays even though it's never called.
function errorHandler(err, req, res, next) {
  const appError = toAppError(err);

  if (appError.status >= INTERNAL_ERROR) {
    // Server errors are logged here and never sent to the client. An expected
    // AppError (like 503 "waitlist unavailable") gets one line. Anything else is a
    // bug or an outage, so the whole stack trace is printed.
    if (err instanceof AppError) console.warn(`[warn] ${req.method} ${req.originalUrl}: ${err.message}`);
    else console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  const body = { status: appError.status, message: appError.message, ...appError.extra };
  if (appError.details) body.details = appError.details;
  res.status(appError.status).json({ error: body });
}

module.exports = errorHandler;
