const fs = require('fs');
const path = require('path');
const { collectDemoBrief, readDemoScript } = require('./demo-authoring');

const { parseArgs, resolveConfigPath, USAGE } = require('./cli');
const { capture: defaultCapture } = require('./capture');
const { startCalibrator: defaultStartCalibrator } = require('./calibrator-server');
const {
  DEMO_USAGE,
  buildQuickDemoConfig,
  parseDemoArgs,
  resolveDemoTarget,
  verifyChannelOutputs,
} = require('./quick-demo');

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function errorPayload(error, code) {
  return { ok: false, error, code };
}

/**
 * `take-a-repo demo <url|dir>` — the zero-config path. No config file resolution:
 * the target is the only required input and the config is synthesized.
 */
async function runQuickDemo(argv, io, deps) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const processCwd = io.processCwd || (() => process.cwd());
  const capture = deps.capture || defaultCapture;

  const opts = parseDemoArgs(argv);
  if (opts.help) {
    stdout.write(DEMO_USAGE);
    return 0;
  }
  if (opts.errors.length) {
    const msg = opts.errors.join('; ');
    if (opts.json) writeJson(stdout, errorPayload(msg, 2));
    else stderr.write(`[take-a-repo] ${msg}\n\n${DEMO_USAGE}`);
    return 2;
  }
  const cwd = processCwd();
  try {
    const target = resolveDemoTarget(opts.target, cwd);
    if (opts.brief || (opts.language && !opts.script)) {
      const brief = await (deps.collectDemoBrief || collectDemoBrief)(target, opts.language || 'und');
      const status = opts.brief ? 'authoring-brief' : 'needs-script';
      const payload = { ok: true, status, machineStatus: status, publishable: false, produced: [], brief };
      if (opts.json) writeJson(stdout, payload);
      else stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    const authoredScript = opts.script ? readDemoScript(path.resolve(cwd, opts.script), opts.language) : undefined;
    const config = buildQuickDemoConfig({
      target,
      name: opts.name,
      outDir: opts.out,
      durationS: opts.duration,
      mp4: opts.mp4,
      channels: opts.channels,
      authoredScript,
      font: opts.font,
    });
    const log = opts.json ? (m) => stderr.write(`[take-a-repo] ${m}\n`) : undefined;
    const { produced, outDir } = await capture(config, { cwd, json: opts.json, log });

    // A channel deliverable is only "ready" if the final file measures up, so
    // report the verdict per channel and fail the run when one does not.
    const channels = opts.channels.length
      ? (deps.verifyChannelOutputs || verifyChannelOutputs)(produced, opts.channels, opts.name)
      : [];
    const report = opts.json ? (m) => stderr.write(`[take-a-repo] ${m}\n`) : (m) => stdout.write(`[take-a-repo] ${m}\n`);
    for (const channel of channels) {
      report(channel.ok
        ? `✓ ${channel.target}: ${path.basename(channel.file)} ${channel.width}×${channel.height} ready`
        : `❌ ${channel.target}: ${channel.problems.join('; ')}`);
    }
    // The run function records the script it executed. Report it so the clip's
    // scene order and caption wording are inspectable without watching the file.
    const script = config.demos[0] && config.demos[0].run && config.demos[0].run.script;
    const scenes = script
      ? script.beats.map((beat, index) => ({ n: index + 1, role: beat.role, caption: beat.text }))
      : [];
    for (const scene of scenes) report(`scene ${scene.n} (${scene.role}): ${scene.caption}`);
    if (script && script.droppedHeadings) {
      report(`normalized script: ${script.droppedHeadings} off-spec heading(s) dropped`);
    }

    const failed = channels.filter((channel) => !channel.ok);
    if (failed.length) {
      const msg = `channel output not ready: ${failed.map((c) => `${c.target} (${c.problems.join('; ')})`).join(', ')}`;
      if (opts.json) writeJson(stdout, { ok: false, error: msg, code: 1, outDir, produced, channels, scenes });
      else stderr.write(`[take-a-repo] FAILED: ${msg}\n`);
      return 1;
    }
    const authoring = authoredScript ? { script: authoredScript, captionQA: config.demos[0].run.captionReport } : {};
    if (opts.json) writeJson(stdout, { ok: true, status: 'not-requested', machineStatus: 'capture-only', publishable: false, outDir, produced, channels, scenes, ...authoring });
    return 0;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const code = Number.isInteger(err && err.exitCode) ? err.exitCode : 1;
    if (opts.json) writeJson(stdout, errorPayload(msg, code));
    else stderr.write(`[take-a-repo] ${code === 2 ? msg : `FAILED: ${err && err.stack ? err.stack : err}`}\n`);
    return code;
  }
}

async function runCli(argv, io = {}, deps = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const processCwd = io.processCwd || (() => process.cwd());
  const capture = deps.capture || defaultCapture;
  const startCalibrator = deps.startCalibrator || defaultStartCalibrator;
  const loadConfig = deps.loadConfig || ((configPath) => require(configPath));

  if (argv[0] === 'demo') return runQuickDemo(argv.slice(1), io, deps);
  if (['inspect', 'status', 'review'].includes(argv[0])) return require('./evidence-cli').runEvidenceCommand(argv, io);

  const opts = parseArgs(argv);
  if (opts.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (opts.errors.length) {
    const msg = opts.errors.join('; ');
    if (opts.json) writeJson(stdout, errorPayload(msg, 2));
    else stderr.write(`[take-a-repo] ${msg}\n\n${USAGE}`);
    return 2;
  }

  const cwd = path.resolve(processCwd(), opts.path || '.');
  const configPath = resolveConfigPath(opts.config, cwd);
  if (!configPath || !fs.existsSync(configPath)) {
    const msg = `No config found (looked for take-a-repo.config.js in ${cwd}). Pass --config <path>.`;
    if (opts.json) writeJson(stdout, errorPayload(msg, 2));
    else stderr.write(`[take-a-repo] ${msg}\n`);
    return 2;
  }

  try {
    const loaded = loadConfig(configPath);
    const config = loaded && loaded.default ? loaded.default : loaded;
    if (opts.calibrate || opts.campaign) {
      if (config.evidence) throw new Error('use take-a-repo review <evidence-outDir> for evidence configs');
      const calibrator = await startCalibrator({
        cwd,
        config,
        configPath,
        port: opts.port == null ? 0 : opts.port,
        open: opts.open,
        ...(opts.campaign ? { view: 'campaign' } : {}),
      });
      const dashboardUrl = opts.campaign ? calibrator.campaignUrl || `${calibrator.url}/campaign/` : calibrator.url;
      const status = opts.campaign ? 'campaign-dashboard' : 'calibrating';
      if (opts.json) writeJson(stdout, { ok: true, status, url: dashboardUrl });
      else stdout.write(`[take-a-repo] ${opts.campaign ? 'campaign dashboard' : 'calibrator'}: ${dashboardUrl}\n`);
      return 0;
    }
    const log = opts.json ? (m) => stderr.write(`[take-a-repo] ${m}\n`) : undefined;
    const {
      produced,
      outDir,
      manifest = null,
      status = 'not-requested',
      machineStatus = 'not-requested',
      exitCode = 0,
    } = await capture(config, { ...opts, cwd, log });
    if (opts.json) writeJson(stdout, { ok: exitCode === 0, status, machineStatus, outDir, manifest, produced });
    return exitCode;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const code = Number.isInteger(err && err.exitCode) ? err.exitCode : 1;
    if (opts.json) {
      writeJson(stdout, errorPayload(msg, code));
    } else {
      const detail = code === 2 ? msg : (err && err.stack ? err.stack : err);
      stderr.write(`[take-a-repo] ${code === 2 ? msg : `FAILED: ${detail}`}\n`);
    }
    return code;
  }
}

module.exports = { runCli };
