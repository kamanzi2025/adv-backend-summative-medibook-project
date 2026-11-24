// GET /feedback: the course feedback page in the requested language (Part G).
const { loadLocales, resolveLanguage, formatToday } = require('../utils/i18n');
const { renderFeedbackPage } = require('../utils/feedbackPage');
const { clinicNow, toSqlDate } = require('../utils/clock');

// The locale files are read once, asynchronously, when the app starts, not on
// every request and never with a *Sync call. Each request awaits the same promise,
// which has already resolved by then, so the handler does no file I/O at all.
// If loading fails, the error is printed now and every request gets a 500 from
// the error handler. The .catch also stops an unhandled rejection from crashing
// the process before the first request arrives.
const localesReady = loadLocales();
localesReady.catch((err) => console.error('[error] Could not load the /feedback locale files:', err.message));

/** GET /feedback?lang=en|fr (any other value gets English) */
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
