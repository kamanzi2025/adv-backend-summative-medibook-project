// GET /feedback: the course-feedback page in the requested language (README Part G).
const { loadLocales, resolveLanguage, formatToday } = require('../utils/i18n');
const { renderFeedbackPage } = require('../utils/feedbackPage');
const { clinicNow, toSqlDate } = require('../utils/clock');

// The locale files are read ONCE, asynchronously, when this module is first required
// (at app startup), never per request and never with *Sync. Every request awaits the
// same memoized promise, which is already settled after startup, so no file I/O happens
// in the handler. If loading fails, the error is logged now and every request gets a
// 500 through the central error handler (the .catch also prevents an unhandled
// rejection from crashing the process before the first request).
const localesReady = loadLocales();
localesReady.catch((err) => console.error('[error] Could not load the /feedback locale files:', err.message));

/** GET /feedback?lang=en|fr (anything else falls back to English) */
async function getFeedbackPage(req, res) {
  const locales = await localesReady;
  const language = resolveLanguage(req.query.lang);
  const instant = new Date();
  const html = renderFeedbackPage({
    language,
    texts: locales[language],
    todayText: formatToday(instant, language),
    todayIso: toSqlDate(clinicNow(instant)),
    languages: Object.values(locales).map((texts) => ({ key: texts.lang, name: texts.languageName })),
  });
  res.type('html').set('Content-Language', language).send(html);
}

module.exports = { getFeedbackPage };
