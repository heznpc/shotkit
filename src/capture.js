/*
 * take-a-repo — the capture runner (programmatic API).
 *
 * `capture(config, opts)` builds the project (if configured), loads the built
 * extension into Playwright, drives each scene into a money-shot state, and
 * writes into `outDir`:
 *   - <scene>.png      one screenshot per scene (CWS or SNS sizes)
 *   - <promoTile>.png  one promo tile per promoTiles entry
 *   - <demo>.webm      a captionable demo screencast (unless opts.noVideo)
 *   - <demo>.mp4       optional H.264 version for SNS
 *   - storyboard.json / captions.json / take-a-repo-manifest.json
 *   - description.md   listing copy extracted from STORE_LISTING.md or product.manifest.json
 *   - privacy-disclosure.md worksheet extracted from product.manifest.json
 *
 * Because it runs the project's real `build` first and loads the BUILT bundle,
 * a clean run doubles as a real-bundle smoke test: a screenshot only appears if
 * that feature rendered from the shipped code.
 *
 * The CLI (bin/take-a-repo.js), --json agent contract, and capture skill are thin
 * wrappers over this function.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { launchBrowser, closeContext } = require('./launch');
const {
  extractListing,
  extractProductManifest,
  hasJsonExtension,
  renderDescriptionDoc,
  renderPrivacyDisclosureDoc,
} = require('./describe');
const { resolveSize } = require('./presets');
const { analyzeDemoStoryboard, normalizeDemoConfigs } = require('./demo');
const { captureDemo, DemoPostProcessError } = require('./capture-demo');
const { normalizeSetup } = require('./capture-lifecycle');
const { createCapturePlan, DEFAULT_VIEWPORT } = require('./capture-plan');
const { captureStaticAssets } = require('./capture-static');
const { applyCalibrationProfiles, loadCalibration } = require('./calibration');
const { deliveryStatus } = require('./approval');
const { assetRecord, writeHandoffDocs } = require('./handoff');

function isManagedTempDir(dir, prefix) {
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith(prefix);
}

function normalizePreparedExtension(result) {
  if (typeof result === 'string') {
    return {
      dir: result,
      cleanup: isManagedTempDir(result, 'store-ext-') ? () => fs.rmSync(result, { recursive: true, force: true }) : null,
    };
  }
  if (result && typeof result.dir === 'string') {
    return {
      dir: result.dir,
      cleanup: typeof result.cleanup === 'function' ? result.cleanup : null,
    };
  }
  throw new Error('prepareExtension() must return an extension directory string or { dir, cleanup }');
}

/**
 * @param {object} config  the project's take-a-repo config object (scenes, etc.)
 * @param {object} [opts]
 * @param {string[]} [opts.scenes]   only capture these names (scenes/promoTiles/demo/demos/"description"/"privacy")
 * @param {string[]} [opts.targets]  only capture these configured channel targets
 * @param {boolean} [opts.noVideo]   skip the demo screencast
 * @param {boolean} [opts.noBuild]   skip config.build
 * @param {boolean} [opts.mp4]       also convert the demo webm to H.264 mp4
 * @param {boolean} [opts.liveGt]    passed to config hooks as flags.liveGt
 * @param {boolean} [opts.freeze]    passed to config hooks as flags.freeze
 * @param {string}  [opts.cwd]       project root for build / outDir / listing sources
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{produced: string[], outDir: string, manifest: string|null, status:string, machineStatus:string}>}
 */
async function captureBrowser(config, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const log = opts.log || ((msg) => console.log(`[take-a-repo] ${msg}`));
  const calibration = loadCalibration(config, cwd);
  const demoConfigs = applyCalibrationProfiles(normalizeDemoConfigs(config), calibration.document);
  const plan = createCapturePlan({ config, opts, cwd, demoConfigs });
  const {
    bandHeight,
    defaultViewport,
    needsBrowser,
    only,
    outDir,
    partial,
    passFlags,
    requestedDemoConfigs,
    selectedDemoConfigs,
    shouldRunTextPass,
    shouldRunVisualPass,
    targetOnly,
    wants,
  } = plan;
  const produced = [];
  let manifest = null;
  let status = 'not-requested';
  let machineStatus = 'not-requested';
  const assets = [];
  const capturedDemoConfigs = [];
  const demoViewports = {};
  const demoWarnings = {};
  const demoCaptionReports = {};
  fs.mkdirSync(outDir, { recursive: true });
  const tempDirs = [];
  let fatalDemoError = null;
  const demoErrors = [];
  let cleaned = false;
  let extensionCleanup = null;

  const cleanupTempResources = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (err) {
        log(`⚠️  cleanup failed for ${d}: ${err.message}`);
      }
    }
    if (extensionCleanup) {
      try {
        await extensionCleanup();
      } catch (err) {
        log(`⚠️  extension cleanup failed: ${err.message}`);
      }
    }
  };

  const registerAsset = (filePath, meta, message) => {
    produced.push(filePath);
    assets.push(assetRecord({ cwd, outDir, filePath, ...meta }));
    if (message) log(message);
  };
  const writeAsset = (filePath, data, meta, message) => {
    fs.writeFileSync(filePath, data);
    registerAsset(filePath, meta, message);
  };

  try {
    // 1. Build — the smoke test starts here. `config.build` is a repo-committed
    // command string (same trust boundary as a package.json script), run through
    // a shell so projects can write `npm run build:bundle`; never user input.
    if (config.build && !opts.noBuild && needsBrowser) {
      log(`build: ${config.build}`);
      // In --json mode stdout must stay a single JSON object, so route the build
      // command's stdout to our stderr (fd 2) instead of inheriting it.
      execSync(config.build, { stdio: opts.json ? ['ignore', 2, 2] : 'inherit', cwd });
    }

    if (shouldRunTextPass && config.description && config.description.from) {
      const sourcePath = path.resolve(cwd, config.description.from);
      if (hasJsonExtension(sourcePath)) {
        const product = extractProductManifest(sourcePath, { channel: config.description.channel });
        if (wants('description')) {
          writeAsset(
            path.join(outDir, 'description.md'),
            renderDescriptionDoc(product.listing),
            {
              name: 'description',
              type: 'text',
              role: 'store-listing-copy',
              source: { kind: 'productManifest', path: config.description.from },
            },
            '✓ description.md',
          );
          if (product.listing.warnings.length) log(`⚠️  ${product.listing.warnings.join('; ')}`);
        }
        if (wants('privacy')) {
          writeAsset(
            path.join(outDir, 'privacy-disclosure.md'),
            renderPrivacyDisclosureDoc(product.privacy),
            {
              name: 'privacy',
              type: 'text',
              role: 'privacy-disclosure',
              source: { kind: 'productManifest', path: config.description.from },
            },
            '✓ privacy-disclosure.md',
          );
          if (product.privacy.warnings.length) log(`⚠️  ${product.privacy.warnings.join('; ')}`);
        }
      } else if (wants('description')) {
        const listing = extractListing(sourcePath);
        writeAsset(
          path.join(outDir, 'description.md'),
          renderDescriptionDoc(listing),
          {
            name: 'description',
            type: 'text',
            role: 'store-listing-copy',
            source: { kind: 'description' },
          },
          '✓ description.md',
        );
        if (listing.warnings.length) log(`⚠️  ${listing.warnings.join('; ')}`);
      }
    }

    // 2. Prepare the unpacked extension dir to load only when a browser capture
    // is required. Text-only description/privacy runs should not depend on
    // Chromium, build artifacts, or extension manifests. Configs without
    // prepareExtension capture a plain web app — scenes/demos get extensionId:null.
    let extensionDir = null;
    if (needsBrowser && typeof config.prepareExtension === 'function') {
      const preparedExtension = normalizePreparedExtension(await config.prepareExtension(passFlags));
      extensionDir = preparedExtension.dir;
      extensionCleanup = preparedExtension.cleanup;
    }

    // 3. Screenshots + promo run in a no-video context.
    if (shouldRunVisualPass) {
      const ctx = await launchBrowser({ extensionDir, viewport: defaultViewport });
      let setup = normalizeSetup(null);
      try {
        setup = normalizeSetup(
          config.setup ? await config.setup({ context: ctx.context, extensionId: ctx.extensionId, flags: passFlags }) : null,
        );
        await captureStaticAssets({
          config,
          context: ctx.context,
          extensionId: ctx.extensionId,
          setup,
          passFlags,
          wants,
          defaultViewport,
          bandHeight,
          outDir,
          writeAsset,
        });
      } finally {
        // Close the context (drops the browser's sockets) BEFORE the fixture server:
        // server.close() waits for open connections to drain, and a still-open page
        // keeps a keep-alive socket that would otherwise deadlock the close.
        try {
          await closeContext(ctx);
        } finally {
          await setup.teardown();
        }
      }
    }

    // 4. Demo screencasts — separate context per demo so only that walkthrough
    // records video and each clip can choose its own viewport/captions/trim.
    for (const demoConfig of selectedDemoConfigs) {
      const viewport = resolveSize(demoConfig.preset || demoConfig.viewport, defaultViewport);
      demoViewports[demoConfig.name] = viewport;
      // Runtime-captioned demos (e.g. the zero-config quick demo) opt out of
      // static storyboard lint with lint:false — their captions don't exist yet.
      const warnings = demoConfig.lint === false || demoConfig.storyboardLint === false ? [] : analyzeDemoStoryboard(demoConfig, {
        viewport,
        mp4Requested: !!(demoConfig.mp4 || opts.mp4 || demoConfig.crop || demoConfig.zoom),
      });
      demoWarnings[demoConfig.name] = warnings;
      for (const warning of warnings) {
        log(`⚠️  ${demoConfig.name}: ${warning.message}${warning.fix ? `; ${warning.fix}` : ''}`);
      }
      const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-video-'));
      tempDirs.push(videoDir);
      const demoCtx = await launchBrowser({ extensionDir, viewport, recordVideoDir: videoDir, recordVideoSize: viewport });
      const resources = { setup: normalizeSetup(null), page: null };
      try {
        const result = await captureDemo({
          config,
          demoConfig,
          opts,
          cwd,
          outDir,
          viewport,
          passFlags,
          demoCtx,
          resources,
          registerAsset,
          log,
        });
        capturedDemoConfigs.push(demoConfig);
        demoCaptionReports[demoConfig.name] = result.captionMetricReport;
        demoWarnings[demoConfig.name].push(...result.runtimeCaptionWarnings);
      } catch (err) {
        if (err instanceof DemoPostProcessError) {
          fatalDemoError = err;
          log(`❌ ${fatalDemoError.message}`);
          break;
        }
        // One demo run/recording failure must not abort the remaining demos, the
        // later teardown, but it must still make the run fail. A requested demo
        // clip missing from produced[] is a false-positive success signal.
        demoErrors.push({ name: demoConfig.name, error: err });
        log(`❌ demo "${demoConfig.name}" failed: ${err.message} — continuing with the remaining demos`);
      } finally {
        if (resources.page && !resources.page.isClosed()) await resources.page.close().catch(() => {});
        try {
          await closeContext(demoCtx);
        } finally {
          await resources.setup.teardown();
        }
      }
    }

    if (fatalDemoError) throw fatalDemoError;
    if (demoErrors.length) {
      const names = demoErrors.map((item) => item.name).join(', ');
      throw new Error(`demo capture failed for: ${names}`, { cause: demoErrors[0].error });
    }

    // 5. Machine contract — target QA and fix/retry actions for agents, with
    // legacy adapter hints available only when manual fallback is requested.
    if (config.handoff !== false) {
      const handoffPaths = writeHandoffDocs({
        cwd,
        outDir,
        config,
        assets,
        demoConfigs: capturedDemoConfigs,
        demoViewports,
        demoWarnings,
        demoCaptionReports,
        flags: passFlags,
        // Scene-filtered or --no-video runs only re-capture a subset; merge into
        // the existing handoff contract rather than clobbering a prior full run.
        partial,
        run: {
          requestedScenes: [...only],
          requestedTargets: [...targetOnly],
          attempt: opts.attempt || 1,
          video: !opts.noVideo,
          noBuild: !!opts.noBuild,
          mp4: !!opts.mp4,
          configuredDemos: demoConfigs.map((demoConfig) => demoConfig.name),
          configuredTargets: [...new Set(demoConfigs.map((demoConfig) => demoConfig.target).filter(Boolean))],
          configuredTargetDemos: demoConfigs
            .filter((demoConfig) => demoConfig.target)
            .map((demoConfig) => ({ name: demoConfig.name, story: demoConfig.story, target: demoConfig.target })),
          selectedDemos: requestedDemoConfigs.map((demoConfig) => demoConfig.name),
          capturedDemos: capturedDemoConfigs.map((demoConfig) => demoConfig.name),
          skippedDemos: requestedDemoConfigs
            .filter((demoConfig) => !capturedDemoConfigs.includes(demoConfig))
            .map((demoConfig) => demoConfig.name),
        },
      });
      produced.push(...handoffPaths);
      manifest = path.join(outDir, 'take-a-repo-manifest.json');
      const handoff = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      machineStatus = handoff.handoff && handoff.handoff.automation
        ? handoff.handoff.automation.status
        : 'not-requested';
      status = deliveryStatus(handoff);
      log(`automation: ${machineStatus}; delivery: ${status}`);
      for (const out of handoffPaths) log(`✓ ${path.basename(out)}`);
    }

    log(`done — ${produced.length} asset(s) in ${path.relative(cwd, outDir) || '.'}/`);
    return { produced, outDir, manifest, status, machineStatus };
  } finally {
    await cleanupTempResources();
  }
}

async function capture(config, opts = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('capture config must be an object');
  if (config.evidence) return require('./evidence-runner').captureEvidence(config, opts);
  // Usage errors must not invalidate a previous candidate or create output.
  createCapturePlan({ config, opts, cwd: opts.cwd || process.cwd(), demoConfigs: normalizeDemoConfigs(config) });
  const outDir = path.resolve(opts.cwd || process.cwd(), config.outDir || 'store-assets');
  return require('./run-session').withRunSession(outDir, () => captureBrowser(config, opts));
}

module.exports = { capture, DEFAULT_VIEWPORT };
