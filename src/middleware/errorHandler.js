// The ONE place that turns errors into HTTP responses.
// Response shape for every error: { error: { status, message, details? } }
const AppError = require('../utils/AppError');
const { mapDbError } = require('../utils/dbErrorMap');

const INTERNAL_ERROR = 500;

function toAppError(err) {
  if (err instanceof AppError) return err;

  // express.json() failures (body-parser sets err.type).
  if (err.type === 'entity.parse.failed') {
    return AppError.badRequest('Malformed JSON in request body', [
      { field: 'body', message: 'is not valid JSON' },
    ]);
  }
  if (err.type === 'entity.too.large') {
    return new AppError(413, 'Request body is too large');
  }

  const mapped = mapDbError(err);
  if (mapped) return new AppError(mapped.status, mapped.message, mapped.details);

  // Other 4xx errors raised by Express itself (e.g. unsupported charset).
  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < INTERNAL_ERROR) {
    return new AppError(status, err.expose ? err.message : 'Bad request');
  }

  return new AppError(INTERNAL_ERROR, 'Internal server error');
}

// Express recognises error middleware by its 4 parameters, so `next` must stay
// in the signature even though it isn't called.
function errorHandler(err, req, res, next) {
  const appError = toAppError(err);

  if (appError.status >= INTERNAL_ERROR) {
    // Details go to the server console only, never to the client. An expected
    // AppError (e.g. 503 waitlist unavailable) gets one line; anything else is a
    // bug or an outage and gets the full stack trace.
    if (err instanceof AppError) console.warn(`[warn] ${req.method} ${req.originalUrl}: ${err.message}`);
    else console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  const body = { status: appError.status, message: appError.message, ...appError.extra };
  if (appError.details) body.details = appError.details;
  res.status(appError.status).json({ error: body });
}

module.exports = errorHandler;
