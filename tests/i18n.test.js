const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  FEEDBACK_QUESTION_COUNT, loadLocales, resolveLanguage, formatToday,
} = require('../src/utils/i18n');
const { escapeHtml, renderFeedbackPage } = require('../src/utils/feedbackPage');

const ZONE = 'Africa/Johannesburg'; // UTC+2, no daylight saving

// README Part G, verbatim.
const README_QUESTIONS = [
  'Which topic in this course did you find most challenging, and why?',
  'Describe one concept you understood only after the practical assignments. What made it click?',
  'How has your approach to designing databases or APIs changed since the start of the trimester?',
  'What would you improve about how this course was taught or assessed?',
  'How do you plan to apply what you learned in this course going forward?',
];

let locales;
beforeAll(async () => {
  locales = await loadLocales();
});

function renderFor(language, texts = locales[language]) {
  return renderFeedbackPage({
    language,
    texts,
    todayText: formatToday(new Date('2027-03-15T08:00:00Z'), language, ZONE),
    todayIso: '2027-03-15',
    languages: [{ key: 'en', name: 'English' }, { key: 'fr', name: 'Français' }],
  });
}

describe('resolveLanguage', () => {
  test('returns a supported language', () => {
    expect(resolveLanguage('fr')).toBe('fr');
    expect(resolveLanguage('en')).toBe('en');
  });

  test('is case-insensitive and ignores surrounding spaces', () => {
    expect(resolveLanguage('FR')).toBe('fr');
    expect(resolveLanguage(' fr ')).toBe('fr');
  });

  test.each([
    ['missing', undefined],
    ['unsupported', 'xx'],
    ['empty', ''],
    ['an array (?lang=fr&lang=en)', ['fr', 'en']],
    ['a number', 42],
    ['an object (?lang[x]=fr)', { x: 'fr' }],
    ['an inherited property name', 'constructor'],
    ['__proto__', '__proto__'],
  ])('falls back to English when the value is %s', (_label, raw) => {
    expect(resolveLanguage(raw)).toBe('en');
  });
});

describe('locale files', () => {
  test('en.json and fr.json have identical keys', () => {
    expect(Object.keys(locales.fr).sort()).toEqual(Object.keys(locales.en).sort());
  });

  test('each has exactly 5 questions', () => {
    expect(FEEDBACK_QUESTION_COUNT).toBe(5);
    expect(locales.en.questions).toHaveLength(5);
    expect(locales.fr.questions).toHaveLength(5);
  });

  test('the English questions are exactly the README questions', () => {
    expect(locales.en.questions).toEqual(README_QUESTIONS);
  });

  test('the French texts are actually translated', () => {
    expect(locales.fr.title).not.toBe(locales.en.title);
    locales.fr.questions.forEach((question, i) => expect(question).not.toBe(README_QUESTIONS[i]));
  });

  test('loadLocales rejects a locale file with the wrong number of questions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'medibook-locales-'));
    try {
      await fs.writeFile(path.join(dir, 'en.json'), JSON.stringify(locales.en));
      await fs.writeFile(path.join(dir, 'fr.json'), JSON.stringify({ ...locales.fr, questions: ['Une seule ?'] }));
      await expect(loadLocales(dir)).rejects.toThrow(/fr\.json.*exactly 5/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('formatToday', () => {
  const instant = new Date('2027-03-15T08:00:00Z');

  test('formats the date in English (en-GB)', () => {
    const text = formatToday(instant, 'en', ZONE);
    expect(text).toMatch(/Monday,? 15 March 2027/);
  });

  test('formats the date in French (fr-FR)', () => {
    const text = formatToday(instant, 'fr', ZONE);
    expect(text).toMatch(/lundi 15 mars 2027/);
  });

  test("shows the clinic's date when UTC is still on the previous day", () => {
    // 23:30 UTC on the 14th is already 01:30 on the 15th in Johannesburg.
    const lateUtc = new Date('2027-03-14T23:30:00Z');
    expect(formatToday(lateUtc, 'en', ZONE)).toMatch(/15 March 2027/);
    expect(formatToday(lateUtc, 'en', 'UTC')).toMatch(/14 March 2027/);
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  test('leaves ordinary text (including accents) unchanged', () => {
    expect(escapeHtml('Qu’amélioreriez-vous ?')).toBe('Qu’amélioreriez-vous ?');
  });
});

describe('renderFeedbackPage', () => {
  test('renders exactly 5 labelled textareas', () => {
    const html = renderFor('en');
    expect(html.match(/<textarea/g)).toHaveLength(5);
    for (let i = 1; i <= 5; i += 1) {
      expect(html).toContain(`<label for="q${i}">`);
      expect(html).toContain(`<textarea id="q${i}" name="q${i}"`);
    }
  });

  test('renders a complete English document', () => {
    const html = renderFor('en');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<title>${locales.en.title}</title>`);
    expect(html).toContain('<time datetime="2027-03-15">');
    expect(html).toContain(escapeHtml(README_QUESTIONS[0]));
  });

  test('renders the French page with lang="fr" and French texts', () => {
    const html = renderFor('fr');
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain(escapeHtml(locales.fr.questions[0]));
    expect(html).toContain('lundi 15 mars 2027');
    expect(html).toContain('href="/feedback?lang=en"');
    expect(html).toContain('href="/feedback?lang=fr"');
  });

  test('escapes malicious locale values', () => {
    const texts = {
      ...locales.en,
      title: '<script>alert(1)</script>',
      questions: ['"><img src=x onerror=alert(1)>', ...locales.en.questions.slice(1)],
    };
    const html = renderFor('en', texts);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
  });
});
