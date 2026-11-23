// i18n/l10n helpers for GET /feedback (README Part G).
// Pure functions plus ONE async loader (fs/promises, never *Sync) that is meant to
// run once at startup. No db/redis imports, so unit tests can load this module.
const fs = require('node:fs/promises');
const path = require('node:path');
const { I18N } = require('../config/constants');
const { clinicTimezone } = require('../config/settings');

const DEFAULT_LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');

// README Part G: the form has exactly 5 essay questions.
const FEEDBACK_QUESTION_COUNT = 5;

// Every locale file must define these string keys (plus `questions`).
const REQUIRED_TEXT_KEYS = Object.freeze([
  'lang', 'languageName', 'title', 'heading', 'instructions',
  'dateLabel', 'submit', 'formNote', 'languageSwitchLabel',
]);

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Throws a clear startup error if a locale file is incomplete. */
function validateLocale(language, texts, file) {
  const problems = [];
  for (const key of REQUIRED_TEXT_KEYS) {
    if (!isNonBlankString(texts[key])) problems.push(`"${key}" must be a non-blank string`);
  }
  if (texts.lang !== language) problems.push(`"lang" must be "${language}"`);
  const { questions } = texts;
  if (!Array.isArray(questions) || questions.length !== FEEDBACK_QUESTION_COUNT
    || !questions.every(isNonBlankString)) {
    problems.push(`"questions" must be an array of exactly ${FEEDBACK_QUESTION_COUNT} non-blank strings`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid locale file ${file}: ${problems.join('; ')}`);
  }
}

/**
 * Reads and validates <dir>/<language>.json for every language in I18N.LOCALES.
 * @param {string} [dir]
 * @returns {Promise<Record<string, object>>} e.g. { en: {...}, fr: {...} }
 * @throws {Error} missing file, invalid JSON or missing keys
 */
async function loadLocales(dir = DEFAULT_LOCALES_DIR) {
  const languages = Object.keys(I18N.LOCALES);
  const entries = await Promise.all(languages.map(async (language) => {
    const file = path.join(dir, `${language}.json`);
    const texts = JSON.parse(await fs.readFile(file, 'utf8'));
    validateLocale(language, texts, file);
    return [language, Object.freeze({ ...texts, questions: Object.freeze([...texts.questions]) })];
  }));
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * ?lang= value -> a supported language key. Case-insensitive and trimmed ("FR" -> "fr").
 * Missing, unsupported, or non-string (an array from ?lang=fr&lang=en) -> the default.
 * Object.hasOwn, not `in`, so "constructor" or "__proto__" are never "supported".
 */
function resolveLanguage(raw) {
  if (typeof raw !== 'string') return I18N.DEFAULT_LANGUAGE;
  const key = raw.trim().toLowerCase();
  return Object.hasOwn(I18N.LOCALES, key) ? key : I18N.DEFAULT_LANGUAGE;
}

/**
 * Today's date as text for the language, e.g. "Monday 15 March 2027" / "lundi 15 mars 2027".
 * Pass the REAL instant (new Date()), not a clinic Date: Intl converts the instant
 * into `timeZone` itself. Giving it a clinic Date (UTC fields already shifted to
 * clinic time) together with the clinic time zone would shift it twice.
 * @param {Date} instant
 * @param {string} language  a key of I18N.LOCALES
 * @param {string} [timeZone=clinicTimezone()]
 */
function formatToday(instant, language, timeZone = clinicTimezone()) {
  return new Intl.DateTimeFormat(I18N.LOCALES[language], { dateStyle: 'full', timeZone }).format(instant);
}

module.exports = {
  FEEDBACK_QUESTION_COUNT,
  REQUIRED_TEXT_KEYS,
  loadLocales,
  resolveLanguage,
  formatToday,
};
