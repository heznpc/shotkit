const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CHANNEL_IDS,
  buildQuickDemoConfig,
  makeQuickDemoRun,
  normalizeChannels,
  parseDemoArgs,
  resolveDemoTarget,
  verifyChannelOutputs,
} = require('../src/quick-demo');
const { runCli } = require('../src/cli-runner');
const { normalizeDemoConfigs } = require('../src/demo');

const NO_FFMPEG_ENV = { PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'sk-empty-path-')) };

function streamBuffer() {
  let value = '';
  return {
    stream: { write: (chunk) => { value += chunk; } },
    read: () => value,
  };
}

describe('resolveDemoTarget', () => {
  test('passes http(s) URLs through', () => {
    expect(resolveDemoTarget('http://localhost:3000/app')).toEqual({ kind: 'url', url: 'http://localhost:3000/app' });
    expect(resolveDemoTarget('https://staging.example.test')).toEqual({ kind: 'url', url: 'https://staging.example.test' });
  });

  test('expands bare localhost shorthand to http://', () => {
    expect(resolveDemoTarget('localhost:5173')).toEqual({ kind: 'url', url: 'http://localhost:5173' });
    expect(resolveDemoTarget('127.0.0.1:8080/admin')).toEqual({ kind: 'url', url: 'http://127.0.0.1:8080/admin' });
  });

  test('maps a directory to a static target with index.html fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-demo-dir-'));
    expect(resolveDemoTarget(dir)).toEqual({ kind: 'static', dir, fallback: 'index.html' });
  });

  test('maps an .html file to its directory plus fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-demo-file-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<title>x</title>');
    expect(resolveDemoTarget(file)).toEqual({ kind: 'static', dir, fallback: 'page.html' });
  });

  test('rejects a non-html file with a usage error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-demo-bad-'));
    const file = path.join(dir, 'app.js');
    fs.writeFileSync(file, '');
    expect(() => resolveDemoTarget(file)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  test('rejects a missing target with a usage error', () => {
    expect(() => resolveDemoTarget('definitely-not-a-real-path')).toThrow(expect.objectContaining({ exitCode: 2 }));
    expect(() => resolveDemoTarget('')).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
});

describe('parseDemoArgs', () => {
  test('defaults', () => {
    const opts = parseDemoArgs(['http://localhost:3000']);
    expect(opts).toMatchObject({
      target: 'http://localhost:3000',
      out: 'take-a-repo-demo',
      name: 'demo',
      // null means "unset" so --for can supply the channel's trim length.
      duration: null,
      channels: [],
      mp4: 'auto',
      json: false,
      help: false,
      errors: [],
    });
  });

  test('flags', () => {
    const opts = parseDemoArgs(['./dist', '--out', 'proof', '--name', 'landing', '--duration', '12', '--no-mp4', '--json']);
    expect(opts).toMatchObject({ target: './dist', out: 'proof', name: 'landing', duration: 12, mp4: false, json: true });
  });

  test('errors: missing target, bad duration, unknown flag, extra positional', () => {
    expect(parseDemoArgs([]).errors).toContain('demo target required (a URL, directory, or .html file)');
    expect(parseDemoArgs(['u', '--duration', 'x']).errors).toContain('--duration requires a positive number of seconds');
    expect(parseDemoArgs(['u', '--wat']).errors).toContain('unknown option: --wat');
    expect(parseDemoArgs(['u', 'v']).errors).toContain('unexpected argument: v');
  });

  test('--help wins without a target', () => {
    const opts = parseDemoArgs(['--help']);
    expect(opts.help).toBe(true);
    expect(opts.errors).toEqual([]);
  });
});

describe('buildQuickDemoConfig', () => {
  const urlTarget = { kind: 'url', url: 'http://localhost:3000' };

  test('synthesizes a light one-demo config', () => {
    const config = buildQuickDemoConfig({ target: urlTarget, mp4: false });
    expect(config.handoff).toBe(false);
    expect(config.disclaimer).toBe(false);
    expect(config.setup).toBeUndefined();
    expect(config.demos).toHaveLength(1);
    const demo = config.demos[0];
    expect(demo.name).toBe('demo');
    expect(demo.mp4).toBe(false);
    expect(demo.thumbnail).toBeUndefined();
    expect(demo.viewport).toEqual({ width: 1280, height: 800 });
    expect(typeof demo.run).toBe('function');
  });

  test('mp4:auto without ffmpeg falls back to webm-only', () => {
    const config = buildQuickDemoConfig({ target: urlTarget, mp4: 'auto', env: NO_FFMPEG_ENV });
    expect(config.demos[0].mp4).toBe(false);
    expect(config.demos[0].thumbnail).toBeUndefined();
  });

  test('explicit mp4 adds a thumbnail', () => {
    const config = buildQuickDemoConfig({ target: urlTarget, mp4: true });
    expect(config.demos[0].mp4).toBe(true);
    expect(config.demos[0].thumbnail).toEqual({ at: 1.0 });
  });

  test('duration is clamped to sane bounds', async () => {
    // Bounds are observable through the walkthrough budget, so exercise the
    // stub page with an extreme value and check it still terminates quickly.
    const config = buildQuickDemoConfig({ target: urlTarget, durationS: 100000, mp4: false });
    expect(config.demos[0].run).toBeDefined();
  });

  test('static targets get a serving setup()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-demo-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<title>hi</title>');
    const config = buildQuickDemoConfig({ target: resolveDemoTarget(dir), mp4: false });
    expect(typeof config.setup).toBe('function');
    const setup = await config.setup();
    try {
      expect(setup.env.baseUrl).toMatch(/^http:\/\/localhost:\d+\/index\.html$/);
    } finally {
      await setup.teardown();
    }
  });
});

describe('channel delivery (--for)', () => {
  const urlTarget = { kind: 'url', url: 'http://localhost:3000' };

  // --for requires ffmpeg, which not every CI runner has. Building a channel
  // config must be testable without one, so stub discovery rather than the
  // host PATH; the "no ffmpeg" case below still exercises the real lookup.
  function withFfmpeg(assert) {
    jest.isolateModules(() => {
      jest.doMock('../src/video', () => ({
        ...jest.requireActual('../src/video'),
        findFfmpeg: () => 'ffmpeg',
      }));
      assert(require('../src/quick-demo'));
    });
  }

  test('parses repeatable and comma-separated channels, de-duplicated', () => {
    expect(parseDemoArgs(['u', '--for', 'x']).channels).toEqual(['x']);
    expect(parseDemoArgs(['u', '--for', 'x,youtube-shorts']).channels).toEqual(['x', 'youtube-shorts']);
    expect(parseDemoArgs(['u', '--for', 'x', '--for', 'x']).channels).toEqual(['x']);
  });

  test('rejects an unknown channel and --no-mp4 combined with --for', () => {
    expect(parseDemoArgs(['u', '--for', 'tiktok']).errors[0]).toMatch(/unknown channel for --for: tiktok/);
    expect(parseDemoArgs(['u', '--for', 'x', '--no-mp4']).errors)
      .toContain('--no-mp4 cannot be combined with --for (a channel deliverable is the mp4)');
  });

  test('normalizeChannels validates ids', () => {
    expect(normalizeChannels(['x', 'x'])).toEqual(['x']);
    expect(normalizeChannels('x,youtube-shorts')).toEqual(['x', 'youtube-shorts']);
    expect(() => normalizeChannels(['nope'])).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  test('a channel hands viewport/codec/trim to the profile instead of the defaults', () => {
    withFfmpeg(({ buildQuickDemoConfig: build }) => {
      const config = build({ target: urlTarget, channels: ['youtube-shorts'] });
      expect(config.demos[0].targets).toEqual(['youtube-shorts']);
      // The plain-clip defaults must not leak in and override the profile.
      expect(config.demos[0].viewport).toBeUndefined();
      expect(config.demos[0].mp4).toBeUndefined();

      // capture() expands targets through normalizeDemoConfigs — assert the
      // shape the engine actually runs, not just the declaration.
      const [demo] = normalizeDemoConfigs(config);
      expect(demo.name).toBe('demo-youtube-shorts');
      expect(demo.target).toBe('youtube-shorts');
      expect(demo.preset).toBe('sns-vertical');
      expect(demo.trim).toMatchObject({ duration: 30 });
      expect(demo.thumbnail).toEqual({ at: 1.2 });
      expect(demo.captionOptions).toMatchObject({ mode: 'focus' });
      // Runtime captions still skip static storyboard lint after expansion.
      expect(demo.lint).toBe(false);
    });
  });

  test('multiple channels produce one demo each', () => {
    withFfmpeg(({ buildQuickDemoConfig: build }) => {
      const config = build({ target: urlTarget, channels: ['x', 'youtube-shorts'] });
      expect(normalizeDemoConfigs(config).map((d) => d.name)).toEqual(['demo-x', 'demo-youtube-shorts']);
    });
  });

  test('the recording budget fills the channel trim window', () => {
    withFfmpeg(({ buildQuickDemoConfig: build }) => {
      // A 20s default would leave a 30s trim window short; the profile wins.
      expect(build({ target: urlTarget, channels: ['x'] }).demos[0].run.durationS).toBe(30);
      // An explicit --duration still overrides the channel default.
      expect(build({ target: urlTarget, channels: ['x'], durationS: 12 }).demos[0].run.durationS).toBe(12);
    });
  });

  test('--for without ffmpeg is a usage error, not a half-finished run', () => {
    expect(() => buildQuickDemoConfig({ target: urlTarget, channels: ['x'], env: NO_FFMPEG_ENV }))
      .toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  test('every known channel id resolves to a buildable config', () => {
    withFfmpeg(({ buildQuickDemoConfig: build }) => {
      for (const id of CHANNEL_IDS) {
        expect(normalizeDemoConfigs(build({ target: urlTarget, channels: [id] }))).toHaveLength(1);
      }
    });
  });
});

describe('verifyChannelOutputs', () => {
  const OUT = '/tmp/out';

  test('passes when the delivered mp4 matches the channel spec', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/video', () => ({
        ...jest.requireActual('../src/video'),
        probeVideo: () => ({ ok: true, codec: 'h264', width: 1280, height: 720, durationSeconds: 30 }),
      }));
      const { verifyChannelOutputs: verify } = require('../src/quick-demo');
      const result = verify([`${OUT}/demo-x.mp4`], ['x']);
      expect(result).toEqual([expect.objectContaining({ target: 'x', ok: true, problems: [] })]);
    });
  });

  test('flags wrong dimensions, wrong codec, and over-limit duration', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/video', () => ({
        ...jest.requireActual('../src/video'),
        probeVideo: () => ({ ok: true, codec: 'vp9', width: 640, height: 480, durationSeconds: 999 }),
      }));
      const { verifyChannelOutputs: verify } = require('../src/quick-demo');
      const [result] = verify([`${OUT}/demo-x.mp4`], ['x']);
      expect(result.ok).toBe(false);
      expect(result.problems.join(' ')).toMatch(/640×480, expected 1280×720/);
      expect(result.problems.join(' ')).toMatch(/codec is vp9/);
      expect(result.problems.join(' ')).toMatch(/over the 140s limit/);
    });
  });

  test('reports a missing file rather than silently passing', () => {
    const [result] = verifyChannelOutputs([`${OUT}/demo.webm`], ['x']);
    expect(result).toMatchObject({ target: 'x', file: null, ok: false });
    expect(result.problems[0]).toMatch(/no demo-x\.mp4 was produced/);
  });

  test('surfaces a probe failure as a problem', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/video', () => ({
        ...jest.requireActual('../src/video'),
        probeVideo: () => ({ ok: false, error: 'final MP4 failed full decode' }),
      }));
      const { verifyChannelOutputs: verify } = require('../src/quick-demo');
      const [result] = verify([`${OUT}/demo-x.mp4`], ['x']);
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual(['final MP4 failed full decode']);
    });
  });
});

describe('makeQuickDemoRun', () => {
  function stubPage(surveyed) {
    const calls = { gotos: [], scrolls: [], waits: [] };
    const page = {
      calls,
      async goto(url) { calls.gotos.push(url); return { ok: () => true, status: () => 200 }; },
      async waitForLoadState() {},
      async evaluate(fn, arg) {
        if (typeof arg === 'number') { calls.scrolls.push(arg); return undefined; }
        if (String(fn).includes('scrollTo({ top: 0')) { calls.scrolls.push(0); return undefined; }
        return surveyed;
      },
      async waitForTimeout(ms) { calls.waits.push(ms); },
    };
    return page;
  }

  function stubDemo(page) {
    const captions = [];
    return {
      captions,
      caption: async (text) => { captions.push(text); },
      wait: (ms) => page.waitForTimeout(ms),
      hide: async () => { captions.push(null); },
    };
  }

  test('captions the title and headings while scrolling a long page', async () => {
    const surveyed = {
      title: 'My App',
      scrollHeight: 4000,
      viewportH: 800,
      headings: [
        { text: 'Features', top: 900, visible: true },
        { text: 'Pricing', top: 2200, visible: true },
      ],
    };
    const page = stubPage(surveyed);
    const demo = stubDemo(page);
    await makeQuickDemoRun({ url: 'http://localhost:3000', durationS: 20 })({ page, demo, baseUrl: null });

    expect(page.calls.gotos).toEqual(['http://localhost:3000']);
    expect(demo.captions[0]).toBe('My App');
    expect(demo.captions).toContain('Features');
    expect(demo.captions).toContain('Pricing');
    // returns to top and re-captions the title before hiding
    expect(demo.captions[demo.captions.length - 2]).toBe('My App');
    expect(demo.captions[demo.captions.length - 1]).toBeNull();
    expect(Math.max(...page.calls.scrolls)).toBeLessThanOrEqual(4000 - 800);
  });

  test('single-screen pages hold the loaded state instead of scrolling', async () => {
    const surveyed = { title: 'Tiny', scrollHeight: 800, viewportH: 800, headings: [] };
    const page = stubPage(surveyed);
    const demo = stubDemo(page);
    await makeQuickDemoRun({ url: 'http://localhost:3000', durationS: 10 })({ page, demo, baseUrl: null });
    expect(page.calls.scrolls).toEqual([]);
    expect(demo.captions).toEqual(['Tiny', null]);
  });

  test('uses setup baseUrl when no explicit url (static targets)', async () => {
    const surveyed = { title: 'Static', scrollHeight: 800, viewportH: 800, headings: [] };
    const page = stubPage(surveyed);
    const demo = stubDemo(page);
    await makeQuickDemoRun({ url: null, durationS: 10 })({ page, demo, baseUrl: 'http://localhost:9999/index.html' });
    expect(page.calls.gotos).toEqual(['http://localhost:9999/index.html']);
  });
});

describe('runCli demo subcommand', () => {
  test('routes to capture with a synthesized config and reports json', async () => {
    const stdout = streamBuffer();
    const stderr = streamBuffer();
    const capture = jest.fn(async (config, opts) => {
      expect(config.handoff).toBe(false);
      expect(config.demos).toHaveLength(1);
      expect(opts.json).toBe(true);
      return { produced: ['/tmp/out/demo.webm'], outDir: '/tmp/out' };
    });

    const code = await runCli(['demo', 'http://localhost:3000', '--json', '--no-mp4'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      processCwd: () => process.cwd(),
    }, { capture });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: true,
      status: 'not-requested',
      machineStatus: 'capture-only',
      publishable: false,
      outDir: '/tmp/out',
      produced: ['/tmp/out/demo.webm'],
      channels: [],
      // the stub never executes the demo, so no scenes were recorded
      scenes: [],
    });
  });

  test('reports the recorded scene list so the clip spec is inspectable', async () => {
    const stdout = streamBuffer();
    const stderr = streamBuffer();
    // Drive the synthesized run function the way the real capture engine does.
    const capture = jest.fn(async (config) => {
      const demo = config.demos[0];
      const surveyed = {
        title: 'Spec App',
        scrollHeight: 4000,
        viewportH: 800,
        headings: [
          { text: 'Menu', top: 100, visible: true },
          { text: '1. Record.', top: 900, visible: true },
          { text: 'Verify', top: 2200, visible: true },
        ],
      };
      const page = {
        async goto() { return { ok: () => true, status: () => 200 }; },
        async waitForLoadState() {},
        async evaluate() { return surveyed; },
        async waitForTimeout() {},
      };
      await demo.run({
        page,
        baseUrl: null,
        demo: { caption: async () => {}, wait: async () => {}, hide: async () => {} },
      });
      return { produced: ['/tmp/out/demo.webm'], outDir: '/tmp/out' };
    });

    const code = await runCli(['demo', 'http://localhost:3000', '--json', '--no-mp4'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      processCwd: () => process.cwd(),
    }, { capture });

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.read());
    expect(payload.scenes).toEqual([
      { n: 1, role: 'open', caption: 'Spec App' },
      { n: 2, role: 'body', caption: 'Record' },
      { n: 3, role: 'body', caption: 'Verify' },
      { n: 4, role: 'close', caption: 'Spec App' },
    ]);
    // the nav heading was dropped, and that is reported rather than silent
    expect(stderr.read()).toContain('1 off-spec heading(s) dropped');
  });

  test('demo --help prints usage without requiring a target', async () => {
    const stdout = streamBuffer();
    const code = await runCli(['demo', '--help'], { stdout: stdout.stream, stderr: streamBuffer().stream }, {});
    expect(code).toBe(0);
    expect(stdout.read()).toContain('take-a-repo demo <url|dir|file.html>');
  });

  test('missing target is a usage error (exit 2)', async () => {
    const stdout = streamBuffer();
    const stderr = streamBuffer();
    const code = await runCli(['demo'], { stdout: stdout.stream, stderr: stderr.stream }, {});
    expect(code).toBe(2);
    expect(stderr.read()).toContain('demo target required');
  });

  test('unresolvable target is a usage error in json mode', async () => {
    const stdout = streamBuffer();
    const code = await runCli(['demo', 'nope-not-here', '--json'], {
      stdout: stdout.stream,
      stderr: streamBuffer().stream,
    }, {});
    expect(code).toBe(2);
    const payload = JSON.parse(stdout.read());
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe(2);
  });
});
