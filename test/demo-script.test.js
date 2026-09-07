const {
  CAPTION_MAX_CHARS,
  isBoilerplateHeading,
  normalizeCaption,
  planDemoScript,
  verifyDemoScript,
} = require('../src/demo-script');

const PACING = { introHoldMs: 2400, outroHoldMs: 1600, minStepHoldMs: 1200 };

test('localized feature headings are not mistaken for punctuation', () => {
  expect(isBoilerplateHeading('번역 결과')).toBe(false);
  expect(isBoilerplateHeading('変換結果')).toBe(false);
  expect(isBoilerplateHeading('123…')).toBe(true);
});

function plan(survey, durationS = 20, extra = {}) {
  return planDemoScript(survey, { durationS, ...PACING, ...extra });
}

describe('normalizeCaption', () => {
  test('collapses whitespace and drops trailing sentence punctuation', () => {
    expect(normalizeCaption('  Ship   your\n demo.  ')).toBe('Ship your demo');
    expect(normalizeCaption('Why bother?')).toBe('Why bother');
    expect(normalizeCaption('Install:')).toBe('Install');
  });

  test('strips decorative list numbering and bullets', () => {
    expect(normalizeCaption('1. Install the CLI')).toBe('Install the CLI');
    expect(normalizeCaption('02) Record')).toBe('Record');
    expect(normalizeCaption('- Verify')).toBe('Verify');
    expect(normalizeCaption('## Deliver')).toBe('Deliver');
  });

  test('truncates at a word boundary instead of mid-word', () => {
    const long = 'Record a captioned proof clip of any web application without writing configuration';
    const out = normalizeCaption(long);
    expect(out.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(out.endsWith('\u2026')).toBe(true);
    // the cut lands between words, so no partial word survives
    expect(long.split(' ')).toContain(out.replace(/\u2026$/, '').split(' ').pop());
  });

  test('a single unbroken token still respects the ceiling', () => {
    const out = normalizeCaption('a'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
  });

  test('empty and punctuation-only input yield nothing', () => {
    expect(normalizeCaption('   ')).toBe('');
    expect(normalizeCaption(null)).toBe('');
    expect(normalizeCaption('...')).toBe('');
  });
});

describe('isBoilerplateHeading', () => {
  test('rejects page furniture', () => {
    for (const text of ['Menu', 'On this page', 'Skip to content', 'Search', 'Newsletter', '목차']) {
      expect(isBoilerplateHeading(text)).toBe(true);
    }
  });

  test('rejects meaningless fragments', () => {
    expect(isBoilerplateHeading('')).toBe(true);
    expect(isBoilerplateHeading('4')).toBe(true);
    expect(isBoilerplateHeading('—')).toBe(true);
  });

  test('keeps real content headings', () => {
    for (const text of ['Features', 'How it works', 'Zero-config demo']) {
      expect(isBoilerplateHeading(text)).toBe(false);
    }
  });
});

describe('planDemoScript', () => {
  const longPage = {
    title: 'take-a-repo',
    scrollHeight: 4000,
    viewportH: 800,
    headings: [
      { text: 'Pricing', top: 2200 },
      { text: 'Features', top: 900 },
    ],
  };

  test('opens on the title, walks headings in document order, closes on the title', () => {
    const script = plan(longPage);
    expect(script.beats.map((beat) => [beat.role, beat.text])).toEqual([
      ['open', 'take-a-repo'],
      ['body', 'Features'],
      ['body', 'Pricing'],
      ['close', 'take-a-repo'],
    ]);
    // DOM query order was Pricing-first; the script re-sorts by position.
    expect(script.beats[1].scrollTop).toBeLessThan(script.beats[2].scrollTop);
    expect(verifyDemoScript(script).ok).toBe(true);
  });

  test('body beats are evenly paced inside the duration budget', () => {
    const script = plan(longPage, 20);
    const body = script.beats.filter((beat) => beat.role === 'body');
    expect(new Set(body.map((beat) => beat.holdMs)).size).toBe(1);
    const total = script.beats.reduce((sum, beat) => sum + beat.holdMs, 0);
    expect(total).toBeLessThanOrEqual(20_000);
  });

  test('never scrolls past the scrollable range', () => {
    const script = plan({ ...longPage, headings: [{ text: 'Bottom', top: 3900 }] });
    for (const beat of script.beats) {
      if (beat.scrollTop != null) expect(beat.scrollTop).toBeLessThanOrEqual(4000 - 800);
    }
  });

  test('drops boilerplate headings, title echoes, and case-insensitive repeats', () => {
    const script = plan({
      title: 'take-a-repo',
      scrollHeight: 4000,
      viewportH: 800,
      headings: [
        { text: 'On this page', top: 100 },
        { text: 'Features', top: 900 },
        { text: 'FEATURES', top: 1500 },
        { text: 'take-a-repo', top: 1800 },
        { text: 'Pricing.', top: 2200 },
      ],
    });
    expect(script.beats.filter((beat) => beat.role === 'body').map((beat) => beat.text))
      .toEqual(['Features', 'Pricing']);
    expect(script.droppedHeadings).toBe(3);
  });

  test('caps the beat count so pacing stays readable', () => {
    const headings = Array.from({ length: 20 }, (_, i) => ({ text: `Section ${i + 1}`, top: 200 * (i + 1) }));
    const script = plan({ title: 'Big', scrollHeight: 9000, viewportH: 800, headings }, 30);
    expect(script.bodyBeats).toBe(6);
    expect(verifyDemoScript(script).ok).toBe(true);
  });

  test('a single-screen page holds the open beat instead of inventing scenes', () => {
    const script = plan({ title: 'Tiny', scrollHeight: 800, viewportH: 800, headings: [] }, 10);
    expect(script.beats).toHaveLength(1);
    expect(script.beats[0].scrollTop).toBeNull();
    expect(script.beats[0].holdMs).toBe(10_000);
  });

  test('a scrollable page whose headings are all furniture falls back to holding', () => {
    const script = plan({
      title: 'Nav only',
      scrollHeight: 4000,
      viewportH: 800,
      headings: [{ text: 'Menu', top: 100 }, { text: 'Search', top: 300 }],
    });
    expect(script.bodyBeats).toBe(0);
    expect(script.beats).toHaveLength(1);
  });

  test('captions are normalized to the house ceiling', () => {
    const script = plan({
      title: 'A'.repeat(120),
      scrollHeight: 4000,
      viewportH: 800,
      headings: [{ text: `${'word '.repeat(40)}`, top: 900 }],
    });
    for (const beat of script.beats) expect(beat.text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(verifyDemoScript(script).ok).toBe(true);
  });

  test('a missing title still produces a usable open beat', () => {
    const script = plan({ title: '', scrollHeight: 800, viewportH: 800, headings: [] }, 10);
    expect(script.beats[0].text).toBe('Demo');
  });
});

describe('verifyDemoScript', () => {
  test('flags an empty script', () => {
    expect(verifyDemoScript({ beats: [] }).ok).toBe(false);
    expect(verifyDemoScript(null).problems).toContain('script has no beats');
  });

  test('flags an over-length caption', () => {
    const result = verifyDemoScript({
      beats: [{ role: 'open', text: 'x'.repeat(80), scrollTop: null, holdMs: 1000 }],
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/over the 70 limit/);
  });

  test('flags a missing caption and a missing hold', () => {
    const result = verifyDemoScript({
      beats: [
        { role: 'open', text: '', scrollTop: null, holdMs: 1000 },
        { role: 'close', text: 'End', scrollTop: 0, holdMs: 0 },
      ],
    });
    expect(result.problems).toEqual([
      'beat 1 has no caption text',
      'beat 2 has no hold time',
    ]);
  });

  test('flags repeated body captions and backwards scene order', () => {
    const result = verifyDemoScript({
      beats: [
        { role: 'open', text: 'App', scrollTop: null, holdMs: 2400 },
        { role: 'body', text: 'Features', scrollTop: 1200, holdMs: 2000 },
        { role: 'body', text: 'features', scrollTop: 400, holdMs: 2000 },
        { role: 'close', text: 'App', scrollTop: 0, holdMs: 1600 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/repeats an earlier caption/);
    expect(result.problems.join(' ')).toMatch(/must move down the page/);
  });

  test('flags a script that does not open and close on the title beats', () => {
    const result = verifyDemoScript({
      beats: [
        { role: 'body', text: 'Middle', scrollTop: 100, holdMs: 1000 },
        { role: 'body', text: 'End', scrollTop: 200, holdMs: 1000 },
      ],
    });
    expect(result.problems).toContain('script does not start on an open beat');
    expect(result.problems).toContain('script does not end on a close beat');
  });

  test('counts beats and captions on a passing script', () => {
    const script = plan({
      title: 'App',
      scrollHeight: 4000,
      viewportH: 800,
      headings: [{ text: 'One', top: 900 }, { text: 'Two', top: 2000 }],
    });
    expect(verifyDemoScript(script)).toMatchObject({ ok: true, beats: 4, captions: 4, problems: [] });
  });
});
