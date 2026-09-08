/*
 * take-a-repo quick demo — zero-config proof clip for any web app.
 *
 * `take-a-repo demo <url|dir|file.html>` needs no take-a-repo.config.js: it
 * synthesizes a one-demo config that loads the target, captions the clip with
 * the page's own title and headings, and walks the page with a paced scroll,
 * so the recording proves the app actually renders from a clean run. Video
 * recording, caption overlay, mp4/thumbnail post-processing, and QA all reuse
 * the standard capture engine — this module only decides what to show.
 */

const fs = require('fs');
const path = require('path');

const { CHANNEL_PROFILES, resolveChannelProfile } = require('./channels');
const {
  CAPTION_MAX_CHARS,
  MAX_BODY_BEATS,
  planDemoScript,
  verifyDemoScript,
} = require('./demo-script');
const { serveDirectory } = require('./serve');
const { INSTALL_HINT, findFfmpeg, probeVideo } = require('./video');
const { languageTag, surveyPage, resolveAuthoredScript } = require('./demo-authoring');
const { analyzeDemoCaptionMetrics } = require('./demo-caption-qa');

const CHANNEL_IDS = Object.keys(CHANNEL_PROFILES);
const DEFAULT_DEMO_NAME = 'demo';
const DEFAULT_OUT_DIR = 'take-a-repo-demo';
const DEFAULT_DURATION_S = 20;
const MIN_DURATION_S = 5;
const MAX_DURATION_S = 120;
const INTRO_HOLD_MS = 2400;
const OUTRO_HOLD_MS = 1600;
const MIN_STEP_HOLD_MS = 1200;


function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

/**
 * Classify what the user pointed take-a-repo at.
 * @returns {{kind:'url',url:string}|{kind:'static',dir:string,fallback:string}}
 */
function resolveDemoTarget(input, cwd = process.cwd()) {
  if (!input || typeof input !== 'string') {
    throw usageError('demo target required: a URL (http://localhost:3000) or a static directory / .html file');
  }
  if (/^https?:\/\//i.test(input)) return { kind: 'url', url: input };

  const resolved = path.resolve(cwd, input);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return { kind: 'static', dir: resolved, fallback: 'index.html' };
    if (/\.html?$/i.test(resolved)) {
      return { kind: 'static', dir: path.dirname(resolved), fallback: path.basename(resolved) };
    }
    throw usageError(`demo target ${input} is a file but not .html — pass a URL, a directory, or an .html file`);
  }

  // localhost:3000 / 127.0.0.1:8080 / app.localhost:3000 style shorthand.
  if (/^[\w.-]+(:\d+)?(\/.*)?$/.test(input) && /localhost|^127\.|^0\.0\.0\.0|^\[?::1/.test(input)) {
    return { kind: 'url', url: `http://${input}` };
  }
  throw usageError(`demo target not found: ${input} (no such path, and not an http(s):// or localhost URL)`);
}

/**
 * Validate and de-duplicate requested channel ids.
 * @param {string[]|string} channels
 * @returns {string[]}
 */
function normalizeChannels(channels) {
  const list = Array.isArray(channels) ? channels : [channels];
  const ids = [...new Set(list.flatMap((value) => String(value || '').split(',')).map((v) => v.trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !CHANNEL_IDS.includes(id));
  if (unknown.length) {
    throw usageError(`unknown channel for --for: ${unknown.join(', ')}. Known: ${CHANNEL_IDS.join(', ')}`);
  }
  return ids;
}

/**
 * Check each delivered channel mp4 against its profile's published limits, so
 * "channel-ready" is a measured claim rather than an assumption.
 *
 * @param {string[]} produced  file paths from capture()
 * @param {string[]} channels  requested channel ids
 * @param {string} [demoName]  base demo name used to build per-channel names
 * @returns {Array<{target:string,file:string|null,ok:boolean,width?:number,height?:number,durationSeconds?:number|null,problems:string[]}>}
 */
function verifyChannelOutputs(produced, channels, demoName = DEFAULT_DEMO_NAME) {
  return normalizeChannels(channels).map((id) => {
    const profile = resolveChannelProfile(id);
    const expected = `${demoName}-${profile.outputSuffix}.mp4`;
    const file = (produced || []).find((filePath) => path.basename(filePath) === expected) || null;
    if (!file) {
      return { target: id, file: null, ok: false, problems: [`no ${expected} was produced`] };
    }
    const media = probeVideo(file);
    if (!media.ok) return { target: id, file, ok: false, problems: [media.error || 'final mp4 failed verification'] };

    const problems = [];
    const size = profile.viewport;
    if (media.width !== size.width || media.height !== size.height) {
      problems.push(`is ${media.width}×${media.height}, expected ${size.width}×${size.height}`);
    }
    if (media.codec && media.codec !== 'h264') problems.push(`codec is ${media.codec}, expected h264`);
    if (media.durationSeconds != null && media.durationSeconds > profile.maximumDurationSeconds) {
      problems.push(`is ${media.durationSeconds.toFixed(1)}s, over the ${profile.maximumDurationSeconds}s limit`);
    }
    return {
      target: id,
      file,
      ok: problems.length === 0,
      width: media.width,
      height: media.height,
      durationSeconds: media.durationSeconds,
      problems,
    };
  });
}

/**
 * The auto walkthrough: load → survey the page → run the planned script.
 *
 * The script itself (beat count, scene order, caption wording, pacing) is
 * decided by planDemoScript so every zero-config clip has the same shape
 * regardless of how the target is marked up. This function only executes it,
 * inside the standard demo controller, so captions land in the recorded clip
 * and in caption QA metrics.
 */
function makeQuickDemoRun({ url, durationS, authoredScript }) {
  async function quickDemoRun({ page, demo, baseUrl }) {
    const startUrl = url || baseUrl;
    if (!startUrl) throw new Error('quick demo: no target URL (static server did not provide baseUrl)');

    const response = await page.goto(startUrl, { waitUntil: 'load', timeout: 30_000 });
    if (!response || !response.ok()) {
      throw new Error(`quick demo: navigation failed (HTTP ${response ? response.status() : 'no response'})`);
    }
    // Settle async rendering without hanging on dev servers that never go idle.
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});

    const surveyed = authoredScript ? await surveyPage(page) : await page.evaluate(() => {
      const body = document.body;
      const doc = document.documentElement;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            top: rect.top + window.scrollY,
            visible: rect.width > 0 && rect.height > 0,
          };
        })
        .filter((h) => h.text && h.visible)
        .slice(0, 24);
      return {
        title: document.title || location.host,
        scrollHeight: Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0),
        viewportH: window.innerHeight,
        headings,
      };
    });

    const script = authoredScript ? resolveAuthoredScript(authoredScript, surveyed) : planDemoScript(
      { ...surveyed, title: surveyed.title || startUrl },
      {
        durationS,
        introHoldMs: INTRO_HOLD_MS,
        outroHoldMs: OUTRO_HOLD_MS,
        minStepHoldMs: MIN_STEP_HOLD_MS,
        maxBodyBeats: MAX_BODY_BEATS,
      },
    );
    // The plan is the contract for the clip; refuse to record a script that
    // violates our own caption/scene spec rather than shipping an off-spec clip.
    const check = verifyDemoScript(script);
    if (!check.ok) {
      throw new Error(`take-a-repo: generated demo script is off-spec: ${check.problems.join('; ')}`);
    }

    for (const beat of script.beats) {
      if (beat.role === 'close') {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      } else if (beat.scrollTop != null) {
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), beat.scrollTop);
      }
      await demo.caption(beat.text);
      await demo.wait(beat.holdMs);
    }
    await demo.hide();
    if (authoredScript) {
      const metrics = demo.captionMetrics();
      const warnings = analyzeDemoCaptionMetrics(metrics);
      const failures = warnings.filter((warning) => warning.code !== 'caption-font-not-embedded');
      if (script.beats.some((beat) => !metrics.samples.some((sample) => (sample.sourceText || sample.text) === beat.text))) {
        throw new Error('demo script: an authored caption was not observed in the rendered page');
      }
      if (failures.length) throw new Error(`demo script: caption QA failed: ${failures.map((warning) => warning.code).join(', ')}`);
      quickDemoRun.captionReport = { language: authoredScript.language, sourceDigest: authoredScript.sourceDigest,
        fontDeterministic: metrics.typography.deterministic, warnings, metrics };
    }
    // Hand the executed script back so the CLI can report what was recorded.
    quickDemoRun.script = script;
    return script;
  }
  // Expose the resolved budget so callers (and tests) can see which duration
  // won — the CLI default, an explicit --duration, or the channel's trim.
  quickDemoRun.durationS = durationS;
  return quickDemoRun;
}

/**
 * Build the synthetic capture config for a zero-config demo run.
 *
 * @param {object} opts
 * @param {{kind:string,url?:string,dir?:string,fallback?:string}} opts.target  from resolveDemoTarget()
 * @param {string} [opts.name]        demo/asset name (default "demo")
 * @param {string} [opts.outDir]      output dir (default "take-a-repo-demo")
 * @param {number} [opts.durationS]   clip length budget in seconds (default 20,
 *                                    or the channel's trim length with channels)
 * @param {boolean|'auto'} [opts.mp4] 'auto' = mp4+thumbnail when ffmpeg is found;
 *                                    ignored when channels are given (always mp4)
 * @param {string[]} [opts.channels]  channel ids to deliver (see CHANNEL_IDS); each
 *                                    supplies viewport/codec/trim/caption defaults
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {object} [opts.env]         env for ffmpeg discovery (tests)
 */
function buildQuickDemoConfig({
  target,
  name = DEFAULT_DEMO_NAME,
  outDir = DEFAULT_OUT_DIR,
  durationS,
  mp4 = 'auto',
  channels = [],
  viewport,
  authoredScript,
  font,
  env = process.env,
} = {}) {
  if (!target || !target.kind) throw usageError('buildQuickDemoConfig: target required (use resolveDemoTarget)');
  const profiles = normalizeChannels(channels).map((id) => resolveChannelProfile(id));
  if (authoredScript && durationS != null) throw usageError('--duration cannot override authored beat timing; edit holdMs in the script');
  if (authoredScript && profiles.length) throw usageError('localized quick scripts currently support plain clips; use a capture config for channel variants');
  // A channel deliverable IS the H.264 file, so ffmpeg stops being optional.
  if (profiles.length && !findFfmpeg(env)) {
    throw usageError(`--for needs a channel-ready H.264 file, but ${INSTALL_HINT}`);
  }
  // With a channel, record long enough to fill its trim window; otherwise 20s.
  const requestedDurationS = durationS != null
    ? Number(durationS)
    : (profiles.length
      ? Math.max(...profiles.map((profile) => profile.trim.duration))
      : DEFAULT_DURATION_S);
  const clampedDurationS = Math.min(
    MAX_DURATION_S,
    Math.max(MIN_DURATION_S, requestedDurationS || DEFAULT_DURATION_S),
  );
  const wantsMp4 = mp4 === 'auto' ? !!findFfmpeg(env) : !!mp4;

  const demo = {
    name,
    captions: [],
    // Captions are rendered at runtime from the page's own title/headings,
    // so static storyboard lint has nothing to check.
    lint: false,
    run: makeQuickDemoRun({
      url: target.kind === 'url' ? target.url : null,
      durationS: clampedDurationS,
      authoredScript,
    }),
  };
  if (authoredScript) {
    demo.captionTexts = authoredScript.beats.map((beat) => beat.text);
    demo.captionOptions = { typography: {
      locale: authoredScript.language,
      ...(font ? { fonts: [{ family: 'DemoLocal', from: font }] } : {}),
    } };
  }
  if (profiles.length) {
    // The channel profile owns viewport, preset, codec, trim, and thumbnail —
    // expandDemoTargets applies them and emits one demo per channel.
    demo.targets = profiles.map((profile) => profile.id);
  } else {
    demo.viewport = viewport || { width: 1280, height: 800 };
    demo.mp4 = wantsMp4;
    if (wantsMp4) demo.thumbnail = { at: 1.0 };
  }

  const config = {
    outDir,
    // Own-app proof clips need no trademark disclaimer band by default.
    disclaimer: false,
    // Keep the zero-config surface light: files, not the approval/handoff pack.
    handoff: false,
    demos: [demo],
  };

  if (target.kind === 'static') {
    config.setup = async () => {
      const server = await serveDirectory(target.dir, { fallback: target.fallback });
      return { env: { baseUrl: `${server.baseUrl}/${target.fallback}` }, teardown: () => server.close() };
    };
  }
  return config;
}

const DEMO_USAGE = `take-a-repo demo — record a captioned proof clip of any web app, no config needed

Usage: take-a-repo demo <url|dir|file.html> [options]

Arguments:
  target            what to record: an http(s) URL (dev server), a static
                    directory (served locally), or a single .html file

Options:
  --lang <locale>   request agent-authored captions (e.g. ko); without --script,
                    returns needs-script and a page brief, not an English video
  --brief           inspect the page and return an authoring brief without recording
  --script <file>   record validated agent-authored JSON captions against that brief
  --font <file>     project-local font for deterministic localized rendering
  --for <channel>   deliver a channel-ready file instead of a plain clip;
                    repeatable or comma-separated. The channel owns viewport,
                    codec, duration, and caption style, and the result is
                    verified against its published limits. Needs ffmpeg.
                    Channels: ${CHANNEL_IDS.join(', ')}
  --out <dir>       output directory (default: ${DEFAULT_OUT_DIR})
  --name <name>     clip name (default: ${DEFAULT_DEMO_NAME})
  --duration <s>    clip length budget in seconds (default: ${DEFAULT_DURATION_S},
                    or the channel's trim length with --for; ${MIN_DURATION_S}-${MAX_DURATION_S})
  --no-mp4          keep only the webm (default: mp4 + thumbnail when ffmpeg exists)
  --json            machine-readable: stdout gets one JSON object
                    {ok, outDir, produced[], channels[], scenes[]}; logs go to stderr
  -h, --help        show this help

Output: <name>.webm, and with ffmpeg also <name>.mp4 + <name>-thumbnail.png.
With --for, each channel adds <name>-<channel>.mp4 sized and trimmed for it.

Captions come from the page's own title and headings, rewritten to one scene
spec: open on the title, one beat per content heading in page order, close back
on the title. Nav headings are dropped, repeats are merged, and captions are
capped at ${CAPTION_MAX_CHARS} chars on a word boundary, so two different apps
produce clips with the same rhythm. The recorded scenes are printed per run.

Exit codes: 0 ok · 1 runtime failure · 2 usage error
`;

function parseDemoArgs(argv) {
  const opts = {
    target: null,
    out: DEFAULT_OUT_DIR,
    name: DEFAULT_DEMO_NAME,
    duration: null,
    channels: [],
    mp4: 'auto',
    json: false,
    help: false,
    errors: [],
    language: null,
    brief: false,
    script: null,
    font: null,
  };
  const takeValue = (flag, i) => {
    const value = argv[i + 1];
    if (value == null || value.startsWith('-')) {
      opts.errors.push(`${flag} requires a value`);
      return null;
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--brief') opts.brief = true;
    else if (['--lang', '--script', '--font'].includes(a)) {
      const v = takeValue(a, i);
      if (v != null) {
        i++;
        if (a === '--lang') {
          try { opts.language = languageTag(v); } catch (error) { opts.errors.push(error.message); }
        } else opts[a.slice(2)] = v;
      }
    }
    else if (a === '--no-mp4') opts.mp4 = false;
    else if (a === '--out') { const v = takeValue(a, i); if (v != null) { opts.out = v; i++; } }
    else if (a === '--name') { const v = takeValue(a, i); if (v != null) { opts.name = v; i++; } }
    else if (a === '--for') {
      const v = takeValue(a, i);
      if (v != null) {
        i++;
        const ids = v.split(',').map((id) => id.trim()).filter(Boolean);
        const unknown = ids.filter((id) => !CHANNEL_IDS.includes(id));
        if (unknown.length) opts.errors.push(`unknown channel for --for: ${unknown.join(', ')}. Known: ${CHANNEL_IDS.join(', ')}`);
        else opts.channels.push(...ids);
      }
    }
    else if (a === '--duration') {
      const v = takeValue(a, i);
      if (v != null) {
        i++;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) opts.errors.push('--duration requires a positive number of seconds');
        else opts.duration = n;
      }
    } else if (a.startsWith('-')) opts.errors.push(`unknown option: ${a}`);
    else if (opts.target == null) opts.target = a;
    else opts.errors.push(`unexpected argument: ${a}`);
  }
  if (!opts.help && !opts.target) opts.errors.push('demo target required (a URL, directory, or .html file)');
  if (opts.brief && opts.script) opts.errors.push('--brief cannot be combined with --script');
  if (opts.font && !opts.script) opts.errors.push('--font requires --script');
  opts.channels = [...new Set(opts.channels)];
  if (opts.channels.length && opts.mp4 === false) {
    opts.errors.push('--no-mp4 cannot be combined with --for (a channel deliverable is the mp4)');
  }
  return opts;
}

module.exports = {
  CHANNEL_IDS,
  DEMO_USAGE,
  buildQuickDemoConfig,
  makeQuickDemoRun,
  normalizeChannels,
  parseDemoArgs,
  resolveDemoTarget,
  verifyChannelOutputs,
};
