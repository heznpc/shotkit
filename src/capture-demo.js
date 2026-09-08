const path = require('path');

const { prepareCaptionTypography } = require('./caption-typography');
const { analyzeDemoCaptionMetrics } = require('./demo-caption-qa');
const { createDemoController, installDemoCaptionOverlay } = require('./demo');
const { analyzePng } = require('./image-qa');
const { normalizeSetup } = require('./capture-lifecycle');
const { postProcessDemo, probeVideo } = require('./video');

class DemoPostProcessError extends Error {
  constructor(demoName, error) {
    const message = error && error.message ? error.message : String(error);
    super(`demo "${demoName}" post-processing failed: ${message}`, { cause: error });
    this.name = 'DemoPostProcessError';
  }
}

function demoDisclaimer(config, demoConfig) {
  const value = Object.prototype.hasOwnProperty.call(demoConfig, 'disclaimer')
    ? demoConfig.disclaimer
    : config.disclaimer;
  if (value != null && value !== false && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`demo "${demoConfig.name}".disclaimer must be a non-empty string or false`);
  }
  return value;
}

function installDisclaimer(text) {
  const add = () => {
    if (document.getElementById('__take-a-repo_badge__') || !document.body) return;
    const badge = document.createElement('div');
    badge.id = '__take-a-repo_badge__';
    badge.textContent = text;
    badge.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:rgba(20,21,26,.86);color:#fff;font:600 11px -apple-system,Segoe UI,Roboto,sans-serif;padding:5px 9px;border-radius:6px;pointer-events:none';
    document.body.appendChild(badge);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true });
  else add();
}

async function captureDemo({
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
}) {
  const preparedTypography = await prepareCaptionTypography(
    demoConfig.captionOptions || {},
    cwd,
    [...(demoConfig.captions || []).map((caption) => caption.text), ...(demoConfig.captionTexts || [])],
  );
  await installDemoCaptionOverlay(demoCtx.context, preparedTypography.runtimeOptions);

  const disclaimer = demoDisclaimer(config, demoConfig);
  if (disclaimer) await demoCtx.context.addInitScript(installDisclaimer, disclaimer);

  resources.setup = normalizeSetup(
    config.setup ? await config.setup({
      context: demoCtx.context,
      extensionId: demoCtx.extensionId,
      flags: passFlags,
    }) : null,
  );
  resources.page = await demoCtx.context.newPage();
  await resources.page.setViewportSize(viewport);
  if (preparedTypography.report.enabled) {
    await resources.page.evaluate(async () => {
      if (window.__takeARepoDemoCaption && typeof window.__takeARepoDemoCaption.ready === 'function') {
        await window.__takeARepoDemoCaption.ready();
      }
    });
  }

  const demo = createDemoController({
    page: resources.page,
    captions: demoConfig.captions,
    captionOptions: demoConfig.captionOptions,
    runtimeCaptionOptions: preparedTypography.runtimeOptions,
    typographyReport: preparedTypography.report,
  });
  let captionMetricReport;
  try {
    await demoConfig.run({
      page: resources.page,
      context: demoCtx.context,
      extensionId: demoCtx.extensionId,
      env: resources.setup.env,
      baseUrl: resources.setup.env.baseUrl,
      flags: passFlags,
      demo,
      target: demoConfig.targetProfile || null,
      calibration: demoConfig.calibrationProfile || null,
    });
  } finally {
    captionMetricReport = demo.captionMetrics();
    demo.stop();
  }

  const calibrationProfile = demoConfig.calibrationProfile || {};
  const runtimeCaptionWarnings = analyzeDemoCaptionMetrics(captionMetricReport, {
    viewport,
    protectedRegions: calibrationProfile.protectedRegions || [],
    framing: calibrationProfile.framing || null,
  });
  for (const warning of runtimeCaptionWarnings) {
    log(`⚠️  ${demoConfig.name}: ${warning.message}${warning.fix ? `; ${warning.fix}` : ''}`);
  }

  const video = resources.page.video();
  await resources.page.close();
  if (!video) throw new Error(`demo "${demoConfig.name}" did not produce a video recording`);
  const out = path.join(outDir, `${demoConfig.name}.webm`);
  await video.saveAs(out);
  registerAsset(out, {
    name: demoConfig.name,
    type: 'video',
    role: 'source-demo-webm',
    width: viewport.width,
    height: viewport.height,
    target: demoConfig.target,
    channel: demoConfig.channel,
    source: { kind: 'demo', name: demoConfig.name, story: demoConfig.story, target: demoConfig.target },
  }, `✓ ${demoConfig.name}.webm (${viewport.width}×${viewport.height})`);

  let extra;
  try {
    extra = postProcessDemo({
      webmPath: out,
      mp4: demoConfig.mp4 || opts.mp4,
      trim: demoConfig.trim,
      crop: demoConfig.crop,
      zoom: demoConfig.zoom,
      thumbnail: demoConfig.thumbnail,
      log,
    });
  } catch (error) {
    throw new DemoPostProcessError(demoConfig.name, error);
  }
  for (const extraPath of extra) {
    const format = path.extname(extraPath).toLowerCase();
    const media = format === '.mp4' && demoConfig.target ? probeVideo(extraPath) : undefined;
    const visual = format === '.png' && demoConfig.target ? analyzePng(extraPath) : undefined;
    registerAsset(extraPath, {
      name: path.basename(extraPath, path.extname(extraPath)),
      type: format === '.png' ? 'image' : 'video',
      role: format === '.png' ? 'thumbnail' : 'sns-demo-mp4',
      width: media && media.ok ? media.width : undefined,
      height: media && media.ok ? media.height : undefined,
      target: demoConfig.target,
      channel: demoConfig.channel,
      media,
      visual,
      source: { kind: 'demo', name: demoConfig.name, story: demoConfig.story, target: demoConfig.target },
    });
  }

  return { captionMetricReport, runtimeCaptionWarnings };
}

module.exports = {
  captureDemo,
  DemoPostProcessError,
};
