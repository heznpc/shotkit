const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { ensureDemoCaptionOverlay } = require('./demo');
const { prepareCaptionTypography } = require('./caption-typography');
const { buildCaptionFrames, buildCaptionTimeline } = require('./demo-caption-focus');
const { analyzeDemoCaptionMetrics } = require('./demo-caption-qa');
const { CAPTION_FPS } = require('./production-caption-qa');
const { CAPTION_FIELDS } = require('./editorial');

const frameAt = (seconds) => Math.ceil(seconds * CAPTION_FPS - 1e-8);

function captionSchedule(captions) {
  // A hide event closes each authored interval, including the last caption.
  return captions.flatMap((caption) => [{
    atMs: caption.start * 1000, text: caption.text,
    ...Object.fromEntries(CAPTION_FIELDS.filter((key) => caption[key] !== undefined).map((key) => [key, caption[key]])),
  }, { atMs: caption.end * 1000, text: '' }]);
}

function captionSampleFrames(start, end, movingUntil) {
  if (end <= start) return [];
  const settled = Math.min(end - 1, Math.max(start, movingUntil));
  // Boundary frames catch late starts, phrase swaps, and captions that remain
  // after a hide. The peak and settled frames cover the word-pop itself.
  return [...new Set([start, Math.round(start + (settled - start) * .7), settled, end - 1])].sort((a, b) => a - b);
}

function cleanupCaptionTrack(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    // The portable timeline and all source/final media are retained. Only the
    // renderer's own, reproducible image sequence and concat list are scratch.
    if (entry.isFile() && /^(?:blank\.png|(?:frame|mask)-\d+\.png|track\.ffconcat)$/.test(entry.name)) {
      fs.unlinkSync(path.join(directory, entry.name));
    }
  }
}

async function renderCaptionTrack({ captions, options, viewport, duration, directory, cwd, protectedRegions = [] }) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('caption track requires a positive duration');
  const prepared = await prepareCaptionTypography(options, cwd, captions.map((c) => c.text));
  if (prepared.report.missingGlyphs?.length) throw new Error('caption font is missing authored glyphs');
  const frames = buildCaptionFrames(captionSchedule(captions), options);
  const timeline = buildCaptionTimeline(frames, { endMs: duration * 1000 });
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body></body></html>');
    await ensureDemoCaptionOverlay(page, prepared.runtimeOptions);
    // This switch is used only for QA masks, never for a delivered frame. Make
    // every glyph opaque and remove the panel so its large background cannot
    // dilute a missing-word error, including neutral/inactive focus words.
    await page.addStyleTag({ content: `
      #__take-a-repo_demo_caption__[data-qa-mask="true"] {
        background: transparent !important; border-color: transparent !important;
        box-shadow: none !important; text-shadow: none !important; color: #fff !important;
      }
      #__take-a-repo_demo_caption__[data-qa-mask="true"] .take-a-repo-caption-word {
        color: #fff !important; text-shadow: none !important;
      }
    ` });
    if (!await page.evaluate((color) => CSS.supports('color', color), options.activeColor || '#facc15')) throw new Error('invalid caption activeColor');
    const blank = path.join(directory, 'blank.png');
    fs.writeFileSync(blank, PNG.sync.write(new PNG({ ...viewport })));
    const totalFrames = frameAt(duration);
    const spans = [], samples = [], metrics = [];
    let cursor = 0, serial = 0, previousCaption = null, maskFile = null;
    const append = (file, start, end) => { if (end > start) spans.push({ file, start, end }); };
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (frame.atMs >= duration * 1000) break;
      const start = frameAt(frame.atMs / 1000);
      const end = Math.min(totalFrames, frameAt((frames[i + 1]?.atMs ?? duration * 1000) / 1000));
      append(blank, cursor, start);
      const caption = frame.text
        ? captions.find((c) => c.start * 1000 === frame.sourceAtMs)
        : previousCaption;
      const firstCaption = !!frame.text && !previousCaption;
      const frameOptions = { ...prepared.runtimeOptions, ...frame.options,
        ...(caption?.fontSize ? { fontSize: caption.fontSize } : {}),
        motionAtMs: frame.atMs, motionPaused: true };
      // show('') retains the previous phrase during its exit. Both paths use
      // the live overlay's motion; only the clock is controlled in production.
      await page.evaluate(({ text, style }) => window.__takeARepoDemoCaption.show(text, style), { text: frame.text, style: frameOptions });
      if (frame.text) previousCaption = caption;
      const state = await page.evaluate((at) => window.__takeARepoDemoCaption.seek(at), frame.atMs);
      // Keep same-time hide/show events so adjacent authored captions never
      // acquire an accidental extra frame or restart a complete entrance.
      if (end <= start) continue;
      if (frame.text) {
        // A settled glyph mask lets final-video QA inspect transparent entrance
        // frames and fully hidden exit frames against the clean product source.
        await page.evaluate((at) => window.__takeARepoDemoCaption.seek(at), frame.atMs + state.remainingMs);
        maskFile = path.join(directory, `mask-${String(serial++).padStart(5, '0')}.png`);
        await page.evaluate(() => { document.getElementById('__take-a-repo_demo_caption__').dataset.qaMask = 'true'; });
        try { await page.screenshot({ path: maskFile, omitBackground: true, animations: 'allow' }); }
        finally { await page.evaluate(() => { delete document.getElementById('__take-a-repo_demo_caption__').dataset.qaMask; }); }
        if (firstCaption && start > 0 && caption) samples.push({
          id: caption.id, frame: start - 1, file: blank, maskFile, activeWordIndex: null, phase: 'before',
        });
      }
      const movingUntil = frameAt((frame.atMs + state.remainingMs) / 1000);
      const lastMoving = Math.min(end - 1, Math.max(start, movingUntil));
      const sampleFrames = new Set(captionSampleFrames(start, end, movingUntil));
      let settledFile = blank;
      for (let at = start; at <= lastMoving; at++) {
        const sampled = await page.evaluate((ms) => window.__takeARepoDemoCaption.seek(ms), at * 1000 / CAPTION_FPS);
        if (frame.text && sampled.measurement) metrics.push({ ...sampled.measurement, expectedAtMs: frame.atMs, actualAtMs: at * 1000 / CAPTION_FPS });
        const file = path.join(directory, `frame-${String(serial++).padStart(5, '0')}.png`);
        await page.screenshot({ path: file, omitBackground: true, animations: 'allow' });
        append(file, at, at === lastMoving ? end : at + 1);
        settledFile = file;
        if (sampleFrames.has(at) && caption && maskFile) samples.push({
          id: caption.id, frame: at, file, maskFile,
          activeWordIndex: frame.options.activeWordIndex ?? null,
          phase: frame.text ? (at < movingUntil ? 'motion' : 'hold') : (at < movingUntil ? 'exit' : 'hidden'),
        });
      }
      if (end - 1 > lastMoving && caption && maskFile) samples.push({
        id: caption.id, frame: end - 1, file: settledFile, maskFile,
        activeWordIndex: frame.options.activeWordIndex ?? null, phase: frame.text ? 'hold' : 'hidden',
      });
      cursor = end;
    }
    append(blank, cursor, totalFrames);
    const warnings = analyzeDemoCaptionMetrics({ expectedFrames: frames.filter((frame) => frame.atMs < duration * 1000), samples: metrics, typography: prepared.report }, { viewport, protectedRegions });
    if (warnings.length) throw new Error(warnings.map((warning) => `${warning.code}: ${warning.message}; ${warning.fix}`).join('\n'));
    const concat = path.join(directory, 'track.ffconcat');
    fs.writeFileSync(concat, 'ffconcat version 1.0\n' + spans.map((span) => `file '${path.basename(span.file)}'\noption framerate ${CAPTION_FPS}\nduration ${(span.end - span.start) / CAPTION_FPS}\n`).join('') + `file '${path.basename(spans.at(-1).file)}'\noption framerate ${CAPTION_FPS}\n`);
    return { concat, samples, timeline, metrics, style: options };
  } catch (error) {
    try { cleanupCaptionTrack(directory); }
    catch (cleanupError) { error.message += `; caption scratch cleanup failed: ${cleanupError.message}`; }
    throw error;
  } finally { await browser.close(); }
}

module.exports = { captionSchedule, captionSampleFrames, cleanupCaptionTrack, renderCaptionTrack };
