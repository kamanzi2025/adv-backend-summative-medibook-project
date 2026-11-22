// Pure HTML rendering for GET /feedback. Every inserted value goes through
// escapeHtml, so locale text (or anything else) can never inject markup.

const ANSWER_ROWS = 5;

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** Escapes & < > " ' for use in HTML text and quoted attribute values. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function renderQuestion(question, index) {
  const id = `q${index + 1}`;
  return `      <li>
        <label for="${id}">${escapeHtml(question)}</label>
        <textarea id="${id}" name="${id}" rows="${ANSWER_ROWS}" required></textarea>
      </li>`;
}

function renderLanguageLink({ key, name }, activeLanguage) {
  const current = key === activeLanguage ? ' aria-current="page"' : '';
  return `<a href="/feedback?lang=${encodeURIComponent(key)}" hreflang="${escapeHtml(key)}" lang="${escapeHtml(key)}"${current}>${escapeHtml(name)}</a>`;
}

/**
 * @param {object} args
 * @param {string} args.language   active language key, e.g. "fr"
 * @param {object} args.texts      the active locale file's texts
 * @param {string} args.todayText  today's date formatted for the language
 * @param {string} args.todayIso   today's date as "YYYY-MM-DD" (for <time datetime>)
 * @param {Array<{key: string, name: string}>} args.languages  for the language switch
 * @returns {string} a complete HTML document
 *
 * The form submits with GET back to /feedback and keeps the language (hidden `lang`):
 * the brief asks for a static page, so there is no handler that stores answers, and
 * the server simply ignores the q1..q5 query parameters.
 */
function renderFeedbackPage({ language, texts, todayText, todayIso, languages }) {
  const links = languages.map((entry) => renderLanguageLink(entry, language)).join(' | ');
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(texts.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; background: #fff; }
    nav { text-align: right; font-size: 0.9rem; }
    ol { padding-left: 1.25rem; }
    li { margin-bottom: 1.25rem; }
    label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
    textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 0.5rem; }
    button { font: inherit; padding: 0.5rem 1.25rem; cursor: pointer; }
    .note { color: #555; font-size: 0.9rem; }
  </style>
</head>
<body>
  <nav aria-label="${escapeHtml(texts.languageSwitchLabel)}">${links}</nav>
  <h1>${escapeHtml(texts.heading)}</h1>
  <p>${escapeHtml(texts.dateLabel)} <time datetime="${escapeHtml(todayIso)}">${escapeHtml(todayText)}</time></p>
  <p>${escapeHtml(texts.instructions)}</p>
  <form method="get" action="/feedback">
    <input type="hidden" name="lang" value="${escapeHtml(language)}">
    <ol>
${texts.questions.map(renderQuestion).join('\n')}
    </ol>
    <button type="submit">${escapeHtml(texts.submit)}</button>
    <p class="note">${escapeHtml(texts.formNote)}</p>
  </form>
</body>
</html>
`;
}

module.exports = { escapeHtml, renderFeedbackPage };
