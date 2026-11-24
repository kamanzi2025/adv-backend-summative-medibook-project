// Translation helpers for GET /feedback (Part G). Apart from one async loader
// (fs/promises, never *Sync) that runs once at start-up, these are pure functions
// with no database or Redis imports, so the tests can load this file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { I18N } = require('../config/constants');
const { clinicTimezone } = require('../config/settings');

const DEFAULT_LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');

// The brief asks for exactly 5 essay questions.
const FEEDBACK_QUESTION_COUNT = 5;

// Keys every locale file must have, as well as `questions`.
const REQUIRED_TEXT_KEYS = Object.freeze([
  'lang', 'languageName', 'title', 'heading', 'instructions',
  'dateLabel', 'submit', 'formNote', 'languageSwitchLabel',
]);

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Fails at start-up with a clear message if a locale file is missing something. */
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
 * Reads and checks <dir>/<language>.json for every language in I18N.LOCALES.
 * @param {string} [dir]
 * @returns {Promise<Record<string, object>>} e.g. { en: {...}, fr: {...} }
 * @throws {Error} if a file is missing, isn't valid JSON or lacks a key
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
 * Turns the ?lang= value into a supported language. It ignores case and spaces ("FR" -> "fr").
 * Anything missing, unsupported or not a string (?lang=fr&lang=en gives an array) gets the default.
 * Object.hasOwn is used instead of `in` so "constructor" or "__proto__" never count as languages.
 */
function resolveLanguage(raw) {
  if (typeof raw !== 'string') return I18N.DEFAULT_LANGUAGE;
  const key = raw.trim().toLowerCase();
  return Object.hasOwn(I18N.LOCALES, key) ? key : I18N.DEFAULT_LANGUAGE;
}

/**
 * Today's date written out for the language, e.g. "Monday 15 March 2027" / "lundi 15 mars 2027".
 * Pass the real instant (new Date()), not a clinic Date. Intl already converts the
 * instant into `timeZone`, so a clinic Date, whose fields are already in clinic
 * time, would be shifted twice.
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
