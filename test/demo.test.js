const EventEmitter = require('events');
const { demoSelectInitScript } = require('../src/demo-select');
const {
  DEFAULT_CLICK_HOLD_MS,
  DEFAULT_STEP_HOLD_MS,
  analyzeDemoStoryboard,
  createDemoController,
  demoCaptionInitScript,
  installDemoCaptionOverlay,
  lintDemoStoryboard,
  normalizeDelayMs,
  normalizeDemoConfigs,
  normalizeDemoCaptions,
  parseTimeToMs,
  targetCenter,
} = require('../src/demo');

class FakePage extends EventEmitter {
  constructor() {
    super();
    this.captions = [];
    this.captionCalls = [];
    this.captionSample = null;
    this.clicks = [];
    this.waits = [];
    this.inits = [];
    this.pointerMoves = [];
    this.pointerPulses = 0;
    this.pointerInstalled = false;
    this.selectFocuses = [];
    this.selectReads = [];
    this.selects = [];
    this.selectMirrorEvents = [];
    this.box = null;
    this.mouseClicks = [];
    this.mouse = {
      click: async (x, y, options) => {
        this.mouseClicks.push({ x, y, options });
      },
    };
  }

  async evaluate(fn, arg) {
    if (fn.name === 'hasDemoPointerOverlay') return this.pointerInstalled;
    if (fn.name === 'demoCaptionInitScript') {
      this.inits.push(arg);
      this.pointerInstalled = true;
    }
    if (arg && Object.prototype.hasOwnProperty.call(arg, 'captionText')) {
      this.captions.push(arg.captionText);
      this.captionCalls.push({ text: arg.captionText, options: arg.captionOptions });
      return this.captionSample;
    }
    if (arg && Object.prototype.hasOwnProperty.call(arg, 'pointerPoint')) {
      this.pointerMoves.push({ point: arg.pointerPoint, options: arg.pointerOptions });
    }
    if (arg && Object.prototype.hasOwnProperty.call(arg, 'selectModel')) {
      this.selectMirrorEvents.push({ type: 'show', model: arg.selectModel });
    }
    if (arg && Object.prototype.hasOwnProperty.call(arg, 'selectedValue')) {
      this.selectMirrorEvents.push({ type: 'commit', value: arg.selectedValue });
    }
    if (String(fn).includes('__takeARepoDemoSelect.hide()')) this.selectMirrorEvents.push({ type: 'hide' });
    if (String(fn).includes('__takeARepoDemoPointer.pulse')) this.pointerPulses += 1;
  }

  async waitForTimeout(ms) {
    this.waits.push(ms);
  }

  async click(selector, options) {
    this.clicks.push({ selector, options });
  }

  locator(selector) {
    return {
      boundingBox: async () => this.box,
      evaluate: async (_fn, input) => {
        this.selectReads.push({ selector, input });
        return {
          rect: { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 },
          currentValue: 'en',
          targetValue: input.value,
          items: [
            { index: 0, value: 'en', label: 'English' },
            { gap: true },
            { index: 12, value: input.value, label: '한국어' },
          ],
        };
      },
      focus: async () => this.selectFocuses.push(selector),
      selectOption: async (value) => {
        this.selects.push({ selector, value });
        return [value];
      },
    };
  }
}

afterEach(() => {
  jest.useRealTimers();
});

describe('demo time parsing', () => {
  test('parses seconds and clock strings to milliseconds', () => {
    expect(parseTimeToMs(0.5)).toBe(500);
    expect(parseTimeToMs('4')).toBe(4000);
    expect(parseTimeToMs('00:35')).toBe(35000);
    expect(parseTimeToMs('1:02.5')).toBe(62500);
    expect(parseTimeToMs('00:01:02')).toBe(62000);
  });

  test('rejects invalid or negative times', () => {
    expect(() => parseTimeToMs(-1)).toThrow(/must be >= 0/);
    expect(() => parseTimeToMs('1:65')).toThrow(/invalid time string/);
    expect(() => parseTimeToMs('soon')).toThrow(/invalid time string/);
  });

  test('normalizes and sorts caption schedules', () => {
    expect(normalizeDemoCaptions([
      { at: 4, text: 'B' },
      { at: 0.5, text: 'A' },
    ])).toEqual([
      { atMs: 500, text: 'A' },
      { atMs: 4000, text: 'B' },
    ]);
  });

  test('preserves language-neutral storyboard roles', () => {
    expect(normalizeDemoCaptions([
      { at: 1, text: '元の文章に戻せます', role: 'restore' },
    ])).toEqual([
      { atMs: 1000, text: '元の文章に戻せます', role: 'restore' },
    ]);
    expect(() => normalizeDemoCaptions([
      { at: 1, text: 'Unknown', role: 'surprise' },
    ])).toThrow(/caption.*role/);
  });
});

describe('demo delay validation', () => {
  test('normalizes helper delays as milliseconds', () => {
    expect(normalizeDelayMs(12.6, 'wait ms')).toBe(13);
    expect(() => normalizeDelayMs(-1, 'wait ms')).toThrow(/non-negative/);
    expect(() => normalizeDelayMs(Number.NaN, 'wait ms')).toThrow(/non-negative/);
  });
});

describe('normalizeDemoConfigs', () => {
  const run = async () => {};

  test('supports legacy demo and campaign demos together', () => {
    const legacy = { name: 'demo', run };
    const feature = { name: 'demo-feature', run };
    const restore = { name: 'demo-restore', run };

    expect(normalizeDemoConfigs({ demo: legacy, demos: [feature, restore] })).toEqual([legacy, feature, restore]);
  });

  test('returns an empty list when no demos are configured', () => {
    expect(normalizeDemoConfigs({})).toEqual([]);
  });

  test('rejects invalid demos arrays and duplicate names', () => {
    expect(() => normalizeDemoConfigs({ demos: { name: 'demo' } })).toThrow(/config\.demos must be an array/);
    expect(() => normalizeDemoConfigs({ demos: [{ name: 'a', run }, { name: 'a', run }] })).toThrow(/duplicate demo name "a"/);
  });

  test('requires name and run on each entry', () => {
    expect(() => normalizeDemoConfigs({ demos: [{ run }] })).toThrow(/needs a name/);
    expect(() => normalizeDemoConfigs({ demos: [{ name: 'demo' }] })).toThrow(/needs run/);
  });

  test('expands one story into autonomous channel variants', () => {
    const [cws, x, shorts] = normalizeDemoConfigs({
      demo: {
        name: 'skillbridge',
        targets: ['cws-youtube', 'x', 'youtube-shorts'],
        captions: [{ at: 0.5, text: 'Translate the lesson' }],
        run,
      },
    });

    expect(cws).toMatchObject({
      name: 'skillbridge-cws-youtube',
      story: 'skillbridge',
      target: 'cws-youtube',
      preset: 'sns-video',
      mp4: { crf: 18 },
      trim: { duration: 30 },
      thumbnail: { at: 1.2 },
    });
    expect(x).toMatchObject({ name: 'skillbridge-x', target: 'x', preset: 'sns-video' });
    expect(shorts).toMatchObject({
      name: 'skillbridge-youtube-shorts',
      target: 'youtube-shorts',
      preset: 'sns-vertical',
    });
    expect(cws.run).toBe(run);
    expect(cws.captionOptions).toEqual({ position: 'bottom' });
    expect(x.captionOptions).toEqual({ position: 'bottom' });
    expect(shorts.captionOptions).toEqual({
      position: 'bottom-left',
      mode: 'focus',
      appearance: 'outline',
      wordsPerChunk: 3,
      wordMs: 360,
      activeColor: '#facc15',
      bottomOffset: 380,
    });
    expect(shorts.targetProfile.viewport).toEqual({ width: 720, height: 1280 });
  });

  test('rejects unknown or malformed channel targets', () => {
    expect(() => normalizeDemoConfigs({ demo: { name: 'demo', targets: ['unknown'], run } }))
      .toThrow(/unknown channel target/);
    expect(() => normalizeDemoConfigs({ demo: { name: 'demo', targets: [], run } }))
      .toThrow(/non-empty string array/);
  });

  test('rejects malformed or undeclared target overrides', () => {
    expect(() => normalizeDemoConfigs({
      demo: { name: 'demo', targets: ['x'], targetOptions: { 'youtube-shorts': {} }, run },
    })).toThrow(/contains undeclared target: youtube-shorts/);
    expect(() => normalizeDemoConfigs({
      demo: { name: 'demo', targets: ['x'], targetOptions: { x: true }, run },
    })).toThrow(/targetOptions\.x must be an object/);
  });
});

describe('lintDemoStoryboard', () => {
  test('returns structured lint for agents and string lint for logs', () => {
    const demoConfig = {
      name: 'demo',
      captions: [{ at: 5, text: 'Do the thing' }],
    };

    expect(analyzeDemoStoryboard(demoConfig, { viewport: { width: 1200, height: 675 }, mp4Requested: false }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-mp4',
          severity: 'warning',
          fix: 'set demo.mp4 or run take-a-repo --mp4',
        }),
        expect.objectContaining({
          code: 'odd-viewport',
        }),
      ]));
    expect(lintDemoStoryboard(demoConfig, { viewport: { width: 1200, height: 675 }, mp4Requested: false })[0])
      .toEqual(expect.any(String));
  });

  test('accepts a compact mp4 story with early result and restore beat', () => {
    expect(lintDemoStoryboard({
      name: 'demo',
      mp4: { crf: 18 },
      trim: { duration: '00:30' },
      captions: [
        { at: 0.5, text: 'Translate the lesson in place' },
        { at: 8, text: 'Restore the original anytime' },
      ],
    }, { viewport: { width: 1280, height: 720 }, mp4Requested: true })).toEqual([]);
  });

  test('lints the final trimmed story instead of captions removed from the deliverable', () => {
    const warnings = analyzeDemoStoryboard({
      name: 'trimmed-away-story',
      mp4: true,
      trim: { start: 10, duration: 30 },
      captions: [
        { at: 0.5, text: 'Show the result', role: 'result' },
        { at: 4, text: 'Run the action', role: 'action' },
        { at: 8, text: 'Restore the original', role: 'restore' },
      ],
    }, { viewport: { width: 1280, height: 720 }, mp4Requested: true });

    expect(warnings).toEqual([]); // Caption count cannot establish a visual story.
  });

  test('measures the first retained caption relative to trim.start', () => {
    const warnings = analyzeDemoStoryboard({
      name: 'trimmed-story',
      mp4: true,
      trim: { start: 10, duration: 30 },
      captions: [
        { at: 11, text: 'Show the result', role: 'result' },
        { at: 20, text: 'Restore the original', role: 'restore' },
      ],
    }, { viewport: { width: 1280, height: 720 }, mp4Requested: true });

    expect(warnings.map((warning) => warning.code)).not.toContain('late-first-caption');
  });

  test('accepts a non-English restore beat through its semantic role', () => {
    const warnings = analyzeDemoStoryboard({
      name: 'demo-ja',
      mp4: true,
      trim: { duration: 25 },
      captions: [
        { at: 0.5, text: 'レッスンを翻訳します', role: 'result' },
        { at: 10, text: '元の文章に戻せます', role: 'restore' },
      ],
    }, { viewport: { width: 720, height: 1280 }, mp4Requested: true });
    expect(warnings.map((warning) => warning.code)).not.toContain('missing-safety-restore');
  });

  test('asks agents to space focus-caption beats before publishing', () => {
    const warnings = analyzeDemoStoryboard({
      name: 'demo',
      mp4: true,
      trim: { duration: 25 },
      captionOptions: { mode: 'focus', wordMs: 300 },
      captions: [
        { at: 0, text: 'One two three four' },
        { at: 0.5, text: 'Restore the original' },
      ],
    }, { viewport: { width: 720, height: 1280 }, mp4Requested: true });

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'dense-focus-caption',
        fix: 'move the next caption to at least 1.2s or shorten this caption',
      }),
    ]));
  });

  test('surfaces malformed caption display options as structured lint', () => {
    expect(analyzeDemoStoryboard({
      name: 'demo',
      captionOptions: { mode: 'focus', bottomOffset: -1 },
      captions: [{ at: 0, text: 'Restore the original' }],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'invalid-caption-options',
        fix: 'fix demo.captionOptions before capture',
      }),
    ]));
  });

  test('rejects caption placement outside the rendered viewport', () => {
    expect(analyzeDemoStoryboard({
      name: 'demo',
      mp4: true,
      trim: { duration: 25 },
      captionOptions: { mode: 'focus', bottomOffset: 2000 },
      captions: [
        { at: 0.5, text: 'Show the result' },
        { at: 8, text: 'Restore the original' },
      ],
    }, { viewport: { width: 720, height: 1280 }, mp4Requested: true }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'caption-outside-viewport',
          details: { bottomOffset: 2000, maximumOffset: 1184, viewportHeight: 1280 },
        }),
      ]));
  });

  test('warns about weak story shape and odd video dimensions', () => {
    const warnings = lintDemoStoryboard({
      name: 'demo',
      trim: { duration: '00:12' },
      captions: [{ at: 4, text: 'This caption is intentionally long enough to trigger the short-caption guidance for social clips' }],
    }, { viewport: { width: 1200, height: 675 }, mp4Requested: false });

    expect(warnings.join('\n')).toMatch(/caption is/);
    expect(warnings.join('\n')).toMatch(/should emit mp4/);
    expect(warnings.join('\n')).toMatch(/not even/);
    expect(warnings.join('\n')).not.toMatch(/under 20s/);
  });
});

describe('createDemoController', () => {
  test('tracks burned-in captions even after hiding or a failed browser measurement', async () => {
    const page = new FakePage();
    const demo = createDemoController({ page });
    expect(demo.captionMetrics().captionState).toBe('none');
    await demo.caption('Already in the source pixels');
    await demo.hide();
    expect(demo.captionMetrics().captionState).toBe('burned-in');
    demo.stop();
    const scheduled = createDemoController({ page, captions: [{ at: 60, text: 'Scheduled caption' }] });
    expect(scheduled.captionMetrics().captionState).toBe('burned-in');
    scheduled.stop();
  });

  test('caption renders through the DOM overlay helper', async () => {
    const page = new FakePage();
    const demo = createDemoController({ page, captionOptions: { position: 'bottom' } });
    await demo.caption('Open the course page');
    demo.stop();

    expect(page.inits).toEqual([{ position: 'bottom' }]);
    expect(page.captions).toEqual(['Open the course page']);
  });

  test('keeps authored typography separate from embedded browser font data', async () => {
    const page = new FakePage();
    const captionOptions = {
      mode: 'focus',
      typography: {
        locale: 'ko-KR',
        fonts: [{ family: 'Campaign Sans', from: 'fonts/caption.woff2' }],
      },
    };
    const runtimeCaptionOptions = {
      ...captionOptions,
      typography: {
        enabled: true,
        locale: 'ko-KR',
        direction: 'ltr',
        fontFaces: [{ family: 'Campaign Sans', source: 'data:font/woff2;base64,AA==' }],
      },
    };
    const demo = createDemoController({ page, captionOptions, runtimeCaptionOptions });
    await demo.caption('한국어 자막');
    demo.stop();

    expect(page.captionCalls[0].options.typography).toEqual(runtimeCaptionOptions.typography);
  });

  test('records the browser render timestamp instead of host round-trip completion', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const page = new FakePage();
    page.captionSample = {
      renderedAt: Date.now() + 125,
      rect: { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 },
    };
    const demo = createDemoController({ page });

    await demo.caption('Rendered in the page');
    const report = demo.captionMetrics();
    demo.stop();

    expect(report.samples[0]).toMatchObject({ actualAtMs: 125 });
    expect(report.samples[0]).not.toHaveProperty('renderedAt');
  });

  test('step, click, and wait keep config walkthroughs compact', async () => {
    const page = new FakePage();
    const demo = createDemoController({ page });
    const action = jest.fn(async () => 'ok');

    await expect(demo.step('Translate visible text', action)).resolves.toBe('ok');
    await demo.click('.slider');
    await demo.wait(250);
    demo.stop();

    expect(page.captions).toEqual(['Translate visible text']);
    expect(page.inits).toHaveLength(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(page.clicks).toEqual([{ selector: '.slider', options: {} }]);
    expect(page.waits).toEqual([DEFAULT_STEP_HOLD_MS, DEFAULT_CLICK_HOLD_MS, 250]);
  });

  test('click shows a paced pointer highlight when the selector has a box', async () => {
    const page = new FakePage();
    page.box = { x: 10, y: 20, width: 100, height: 40 };
    const demo = createDemoController({ page });

    await demo.click('.primary', { holdMs: 25, moveMs: 30, beforeMs: 5 });
    demo.stop();

    expect(page.pointerMoves).toEqual([{ point: { x: 60, y: 40 }, options: { durationMs: 30 } }]);
    expect(page.pointerPulses).toBe(1);
    expect(page.clicks).toEqual([{ selector: '.primary', options: {} }]);
    expect(page.waits).toEqual([35, 25]);
  });

  test('click supports locator-like targets and coordinate points', async () => {
    const page = new FakePage();
    const locator = {
      boundingBox: async () => ({ x: 2, y: 4, width: 10, height: 12 }),
      click: jest.fn(async () => {}),
    };
    const demo = createDemoController({ page });

    await demo.click(locator, { holdMs: 0, moveMs: 0, beforeMs: 0 });
    await demo.click({ x: 24, y: 36 }, { holdMs: 0, moveMs: 0, beforeMs: 0, button: 'left' });
    demo.stop();

    expect(locator.click).toHaveBeenCalledWith({});
    expect(page.mouseClicks).toEqual([{ x: 24, y: 36, options: { button: 'left' } }]);
    expect(page.pointerMoves).toEqual([
      { point: { x: 7, y: 10 }, options: { durationMs: 0 } },
      { point: { x: 24, y: 36 }, options: { durationMs: 0 } },
    ]);
  });

  test('select mirrors native options and records a visible pointer action', async () => {
    const page = new FakePage();
    page.box = { x: 10, y: 20, width: 100, height: 40 };
    const demo = createDemoController({ page });

    await expect(demo.select('#language', 'ko', {
      moveMs: 30,
      beforeMs: 5,
      openMs: 40,
      holdMs: 25,
    })).resolves.toEqual(['ko']);
    demo.stop();

    expect(page.selectReads).toEqual([{ selector: '#language', input: { value: 'ko', maxOptions: 7 } }]);
    expect(page.selectFocuses).toEqual(['#language']);
    expect(page.selects).toEqual([{ selector: '#language', value: 'ko' }]);
    expect(page.pointerMoves).toEqual([{ point: { x: 60, y: 40 }, options: { durationMs: 30 } }]);
    expect(page.pointerPulses).toBe(1);
    expect(page.waits).toEqual([35, 40, 25]);
    expect(page.selectMirrorEvents.map((event) => event.type)).toEqual(['show', 'commit', 'hide']);
  });

  test('wait, click, and select reject invalid controls', async () => {
    const page = new FakePage();
    const demo = createDemoController({ page });

    expect(() => demo.wait(-1)).toThrow(/wait ms/);
    await expect(demo.click('.primary', { holdMs: -1 })).rejects.toThrow(/click holdMs/);
    await expect(demo.select('#language', '')).rejects.toThrow(/non-empty option value/);
    await expect(demo.select('#language', 'ko', { maxOptions: 10 })).rejects.toThrow(/between 2 and 9/);
    await expect(demo.caption('Bad position', { position: 'middle' })).rejects.toThrow(/position/);
    demo.stop();
  });

  test('scheduled captions fire relative to demo start and stop cleanly', async () => {
    jest.useFakeTimers();
    const page = new FakePage();
    const demo = createDemoController({
      page,
      captions: [{ at: 0.2, text: 'Protected terms stay intact' }],
    });

    await jest.advanceTimersByTimeAsync(199);
    expect(page.captions).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(page.captions).toEqual(['Protected terms stay intact']);

    demo.stop();
    expect(page.listenerCount('domcontentloaded')).toBe(0);
  });

  test('scheduled focus captions advance the active word without crossing beats', async () => {
    jest.useFakeTimers();
    const page = new FakePage();
    const demo = createDemoController({
      page,
      captions: [
        { at: 0.2, text: 'Translate the lesson now' },
        { at: 0.7, text: 'Restore anytime' },
      ],
      captionOptions: { mode: 'focus', wordsPerChunk: 2, wordMs: 200 },
    });

    await jest.advanceTimersByTimeAsync(200);
    expect(page.captionCalls.at(-1)).toMatchObject({
      text: 'Translate the',
      options: {
        mode: 'focus',
        focusWords: ['Translate', 'the'],
        activeWordIndex: 0,
      },
    });
    await jest.advanceTimersByTimeAsync(200);
    expect(page.captionCalls.at(-1).options.activeWordIndex).toBe(1);
    await jest.advanceTimersByTimeAsync(300);
    expect(page.captionCalls.at(-1)).toMatchObject({
      text: 'Restore anytime',
      options: { activeWordIndex: 0 },
    });
    demo.stop();
  });

  test('replays the active caption after navigation', async () => {
    jest.useFakeTimers();
    const page = new FakePage();
    const demo = createDemoController({ page });
    await demo.caption('Restore the original anytime');
    page.captions = [];

    page.emit('domcontentloaded');
    await jest.advanceTimersByTimeAsync(0);
    demo.stop();

    expect(page.captions).toEqual(['Restore the original anytime']);
  });
});

describe('targetCenter', () => {
  test('uses point targets as-is', async () => {
    await expect(targetCenter(new FakePage(), { x: 1.4, y: 2.6 })).resolves.toEqual({ x: 1, y: 3 });
  });
});

describe('installDemoCaptionOverlay', () => {
  test('registers caption/pointer and native-select init scripts', async () => {
    const context = { addInitScript: jest.fn() };
    await installDemoCaptionOverlay(context, { position: 'bottom-left' });
    expect(context.addInitScript).toHaveBeenCalledTimes(2);
    expect(context.addInitScript).toHaveBeenNthCalledWith(1, expect.any(Function), { position: 'bottom-left' });
    expect(context.addInitScript).toHaveBeenNthCalledWith(2, expect.any(Function));
  });

  test('keeps outline rendering and authored text isolated from host localization', () => {
    const source = String(demoCaptionInitScript);
    expect(source).toContain('[data-appearance="outline"] {');
    expect(source).toContain('[data-appearance="outline"][data-condensed="true"]');
    expect(source).toContain("root.setAttribute('translate', 'no')");
    expect(source).toContain("document.createElement('b')");
    expect(String(demoSelectInitScript)).toContain("root.setAttribute('translate', 'no')");
  });
});

describe('shared live and production caption motion', () => {
  function overlay() {
    const animations = [];
    const rect = { left: 20, top: 100, right: 220, bottom: 150, width: 200, height: 50 };
    const element = () => {
      let text = '';
      const result = {
        dataset: {}, style: { setProperty() {}, removeProperty() {} }, children: [],
        offsetTop: 0, offsetLeft: 0, offsetWidth: 70, offsetHeight: 40,
        scrollWidth: 200, clientWidth: 200, scrollHeight: 50, clientHeight: 50,
        getBoundingClientRect: () => rect,
        setAttribute() {}, removeAttribute() {},
        appendChild(child) { this.children.push(child); },
        querySelectorAll() { return this.children; },
        querySelector(selector) {
          return selector.includes('data-active')
            ? this.children.find((child) => child.dataset.active === 'true') || null
            : this.children[0] || null;
        },
        animate(keyframes, timing) {
          const animation = { keyframes, timing, currentTime: 0, target: this, pause: jest.fn(), cancel: jest.fn() };
          animations.push(animation);
          return animation;
        },
      };
      Object.defineProperty(result, 'textContent', {
        get: () => text,
        set(value) { text = value; result.children = []; },
      });
      return result;
    };
    const root = element();
    root.dataset.position = 'bottom';
    const window = {
      getComputedStyle: (node) => ({
        opacity: node.dataset.visible === 'true' ? '1' : '0',
        transform: 'none', fontSize: '40px', fontFamily: 'system-ui', webkitTextStrokeWidth: '2px',
      }),
    };
    const document = {
      readyState: 'loading', body: {}, addEventListener() {},
      getElementById: (id) => id.endsWith('_style__') ? {} : root,
      createElement: element,
      createRange: () => ({ selectNodeContents() {}, getClientRects: () => [rect] }),
    };
    // Verify the exact initializer Playwright serializes, with no module closure
    // and no browser. Animation creation and time seeking are observable stubs.
    require('vm').runInNewContext(`(${demoCaptionInitScript.toString()})({ position: 'bottom' });`, {
      window, document, performance: { now: () => 10 },
    });
    return { api: window.__takeARepoDemoCaption, root, animations };
  }

  test('word updates preserve the root entrance and retain the phrase through its exit', async () => {
    const { api, root, animations } = overlay();
    await api.show('Keep every word', { mode: 'focus', focusWords: ['Keep', 'every', 'word'], activeWordIndex: 0, motionAtMs: 100, motionPaused: true });
    expect(animations).toHaveLength(2);
    expect(animations[0].timing.duration).toBe(160);
    expect(animations[0].keyframes[1].transform).toBe('translate(-50%, 0px)');
    api.seek(150);
    expect(animations[0].currentTime).toBe(50);
    await api.show('Keep every word', { mode: 'focus', focusWords: ['Keep', 'every', 'word'], activeWordIndex: 1, motionAtMs: 220, motionPaused: true });
    expect(animations.filter((animation) => animation.target === root)).toHaveLength(1);
    expect(animations[0].currentTime).toBe(120);
    expect(root.children.map((child) => child.textContent)).toEqual(['Keep', 'every', 'word']);
    await api.show('', { motionAtMs: 600, motionPaused: true });
    expect(root.children).toHaveLength(3);
    expect(root.dataset.visible).toBe('false');
    expect(animations.at(-1).keyframes[1]).toMatchObject({ opacity: 0, transform: 'translate(-50%, 8px)' });
    expect(api.seek(760).remainingMs).toBe(0);
  });

  test('live animation and sampled animation share the outline pop and differ only in clock control', async () => {
    const live = overlay();
    const sampled = overlay();
    const style = { mode: 'focus', appearance: 'outline', focusWords: ['Restore'], activeWordIndex: 0 };
    await live.api.show('Restore', style);
    await sampled.api.show('Restore', { ...style, motionAtMs: 10, motionPaused: true });
    expect(live.animations.map(({ keyframes, timing }) => ({ keyframes, timing })))
      .toEqual(sampled.animations.map(({ keyframes, timing }) => ({ keyframes, timing })));
    expect(sampled.animations[1].timing.duration).toBe(230);
    expect(live.animations.every((animation) => animation.pause.mock.calls.length === 0)).toBe(true);
    sampled.api.seek(10 + 230 * .7);
    expect(sampled.animations[1].currentTime).toBe(230 * .7);
  });

  test('a newer caption wins when font readiness resolves overlapping show calls', async () => {
    const { api, root } = overlay();
    const stale = api.show('Outdated phrase');
    const latest = api.show('Current phrase');
    expect(await stale).toBeNull();
    await latest;
    expect(root.textContent).toBe('Current phrase');
  });
});
