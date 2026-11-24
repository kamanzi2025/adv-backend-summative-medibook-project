// Builds the HTML for GET /feedback. Every value put into the page goes through
// escapeHtml, so nothing in a locale file can inject markup.

const ANSWER_ROWS = 5;

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** Escapes & < > " ' so text is safe in HTML and inside quoted attributes. */
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
 * @param {string} args.language   the active language, e.g. "fr"
 * @param {object} args.texts      that language's locale file
 * @param {string} args.todayText  today's date written in that language
 * @param {string} args.todayIso   today's date as "YYYY-MM-DD" (for <time datetime>)
 * @param {Array<{key: string, name: string}>} args.languages  for the language links
 * @returns {string} a complete HTML document
 *
 * The form submits with GET back to /feedback and keeps the language in a hidden
 * `lang` field. The brief only asks for the page, so nothing stores the answers;
 * the server just ignores q1..q5 in the query string.
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
