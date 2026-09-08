const { sourceDigest, validateScript, resolveAuthoredScript } = require('../src/demo-authoring');
const { parseDemoArgs, buildQuickDemoConfig, makeQuickDemoRun } = require('../src/quick-demo');
const { runCli } = require('../src/cli-runner');
const { analyzeDemoCaptionMetrics } = require('../src/demo-caption-qa');

const survey = { title: 'Example', paragraphs: ['Visible content'], viewportH: 800,
  headings: [{ id: 'heading-0', text: 'Results', top: 1000 }] };
function script() {
  return { version: 1, language: 'ko-KR', sourceDigest: sourceDigest(survey), beats: [
    { role: 'open', anchor: 'top', text: '화면을 소개합니다', holdMs: 3000 },
    { role: 'body', anchor: 'heading-0', text: '결과를 확인하세요', holdMs: 3000 },
    { role: 'close', anchor: 'top', text: '지금 살펴보세요', holdMs: 3000 },
  ] };
}

test('system font uncertainty is not a false typography application failure', () => {
  const report = { typography: { enabled: true, deterministic: false, locale: 'ko' },
    samples: [{ fontConfigured: false, fitStatus: 'fit' }] };
  expect(analyzeDemoCaptionMetrics(report).map(w => w.code)).toEqual(['caption-font-not-embedded']);
  report.samples[0].fitStatus = 'not-requested';
  expect(analyzeDemoCaptionMetrics(report).map(w => w.code)).toContain('caption-typography-not-applied');
});

test('preserves authored Korean and resolves fresh coordinates without hashing layout', () => {
  expect(validateScript(script(), 'ko')).toEqual(script());
  expect(sourceDigest({ ...survey, viewportH: 400, headings: [{ ...survey.headings[0], top: 1400 }] })).toBe(sourceDigest(survey));
  expect(resolveAuthoredScript(script(), survey).beats[1]).toMatchObject({ text: '결과를 확인하세요', scrollTop: 880 });
});

test.each([
  ['English fallback', s => { s.beats[0].text = 'Welcome'; }],
  ['language mismatch', s => { s.language = 'en'; }],
  ['short timing', s => { s.beats[0].holdMs = 500; }],
  ['unknown actions', s => { s.beats[0].click = '#submit'; }],
  ['unknown top-level fields', s => { s.shell = 'command'; }],
  ['invalid anchor', s => { s.beats[0].anchor = 'heading-0'; }],
  ['missing digest', s => { delete s.sourceDigest; }],
  ['empty language', s => { s.language = ''; }],
])('rejects %s', (_, mutate) => {
  const value = script(); mutate(value);
  expect(() => validateScript(value, 'ko')).toThrow();
});

test('rejects stale content and unknown heading IDs', () => {
  expect(() => resolveAuthoredScript(script(), { ...survey, title: 'Changed' })).toThrow('page content changed');
  const value = script(); value.beats[1].anchor = 'heading-99';
  expect(() => resolveAuthoredScript(value, survey)).toThrow('missing anchor');
});

test('executes authored beats and refuses unobserved captions', async () => {
  const page = { goto: async () => ({ ok: () => true }), waitForLoadState: async () => {},
    evaluate: async (_fn, y) => y == null ? survey : undefined };
  const samples = [];
  const demo = { caption: async text => { samples.push({ text, fitStatus: 'fit' }); }, wait: jest.fn(), hide: async () => {},
    captionMetrics: () => ({ samples, typography: { enabled: true, deterministic: false, locale: 'ko' } }) };
  const run = makeQuickDemoRun({ url: 'http://localhost', authoredScript: script() });
  await run({ page, demo });
  expect(samples.map(s => s.text)).toEqual(script().beats.map(b => b.text));
  expect(demo.wait.mock.calls).toEqual([[3000], [3000], [3000]]);
  expect(run.captionReport.fontDeterministic).toBe(false);
  samples.length = 0;
  demo.caption = async () => {};
  await expect(run({ page, demo })).rejects.toThrow('not observed');
});

test('parses localization flags and refuses ambiguous timing/channel combinations', () => {
  expect(parseDemoArgs(['http://localhost:3000', '--lang', 'ko', '--script', 'ko.json', '--font', 'font.ttf'])).toMatchObject({ language: 'ko', script: 'ko.json', font: 'font.ttf', errors: [] });
  expect(parseDemoArgs(['http://localhost:3000', '--lang', 'not_a_locale']).errors).not.toHaveLength(0);
  expect(parseDemoArgs(['http://localhost:3000', '--brief', '--script', 'ko.json']).errors).not.toHaveLength(0);
  expect(() => buildQuickDemoConfig({ target: { kind: 'url' }, authoredScript: script(), durationS: 5 })).toThrow('--duration');
  expect(() => buildQuickDemoConfig({ target: { kind: 'url' }, authoredScript: script(), channels: ['x'] })).toThrow('channel variants');
});

test.each([['--lang', 'ko'], ['--brief']])('briefing never captures or reports a video (%s)', async (...flags) => {
  let output = '';
  const capture = jest.fn();
  const brief = { source: survey };
  const code = await runCli(['demo', 'http://localhost:3000', ...flags, '--json'],
    { stdout: { write: text => { output += text; } } }, { capture, collectDemoBrief: async () => brief });
  expect(code).toBe(0);
  expect(capture).not.toHaveBeenCalled();
  expect(JSON.parse(output)).toMatchObject({ publishable: false, produced: [], brief });
  expect(JSON.parse(output).status).toBe(flags.includes('--brief') ? 'authoring-brief' : 'needs-script');
});
