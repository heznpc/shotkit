// Integration regression: requires installed Chromium and real FFmpeg/FFprobe.
// All evidence and media are synthetic fixtures in an isolated temporary root.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { runProduction, planProduction, editProduction } = require('../src/production');
const { observeProduction, productionContext } = require('../src/production-observe');
const { capture } = require('../src/capture');
const { sha256File } = require('../src/handoff-files');
const { evidenceState } = require('../src/evidence-state');
const { verifyCaptionTrack } = require('../src/production-caption-qa');
const { renderCaptionTrack, cleanupCaptionTrack } = require('../src/production-captions');
const { resolvedCaptionOptions } = require('../src/production-render');
const { videoComposition } = require('../src/video-composition');
const { createDemoController, installDemoCaptionOverlay } = require('../src/demo');
const { analyzeDemoCaptionMetrics } = require('../src/demo-caption-qa');
const { findFfmpeg, ffmpegTimeoutMs } = require('../src/video');
const { reviewContext, recordEditorialReview } = require('../src/production-review');
const { REVIEW_CRITERIA } = require('../src/editorial');

async function main() {
  const bin = findFfmpeg();
  assert.ok(bin, 'real FFmpeg is required');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-media-regression-'));
  const ffmpeg = (args) => execFileSync(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: ffmpegTimeoutMs(), killSignal: 'SIGKILL',
  });
  try {
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=1:d=21', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(cwd, 'source.mp4')]);
    fs.writeFileSync(path.join(cwd, 'collect.js'), `
const fs = require('fs'), path = require('path'), out = process.env.TAKE_A_REPO_OUTPUT_DIR;
fs.appendFileSync('executions', 'x');
fs.copyFileSync('source.mp4', path.join(out, 'source.mp4'));
fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ version: 1,
  assets: [{ id: 'video', path: 'source.mp4', mediaType: 'video/mp4', role: 'recording', captionState: 'none' }],
  checks: [{ id: 'recorded', status: 'pass', summary: 'Synthetic regression recording', assets: ['video'] }]
}));
`);
    const config = { outDir: 'evidence', evidence: { version: 1,
      producers: [{ id: 'fixture', kind: 'cli', command: [process.execPath, 'collect.js'],
        reuse: { mode: 'local-inputs', inputs: ['collect.js', 'source.mp4'], maxAgeSeconds: 3600 } }],
      claims: [{ id: 'recorded', text: 'Synthetic source recorded', checks: ['fixture:recorded'] }],
      deliverables: [{ id: 'demo', kind: 'video', source: 'fixture:video', channel: 'youtube-shorts', fit: 'contain', claims: ['recorded'],
        trim: { start: 0, duration: 8 },
        editorial: { objective: 'Verify synthetic caption composition', audience: 'Harness test runner', rationale: 'Regression fixture only, not a production quality claim',
          beats: [{ id: 'test', role: 'proof', start: 0, end: 8, subject: 'Caption overlay', expectedChange: 'Authored frames appear and disappear', attention: 'Glyphs and safe lane', holdReason: 'Exercise boundaries and empty intervals' }] },
        captions: [{ id: 'intro', start: 0, end: 3, text: 'W'.repeat(240), fontSize: 42 }] }],
    } };
    const opts = { cwd, log: () => {} };
    const first = await runProduction(config, opts);
    assert.equal(first.machineStatus, 'needs-fix');
    assert.equal(evidenceState(first.outDir).publishable, false);
    assert.match(JSON.parse(fs.readFileSync(first.manifest)).deliverables[0].error, /long-caption/);
    assert.equal(planProduction(config, opts).producers[0].action, 'reuse');
    await observeProduction(config, opts);
    assert.equal(productionContext(config, { ...opts, maxFrames: 2 }).frames.length, 2);
    const detail = productionContext(config, { ...opts, from: 0.3, to: 1.5, resample: true, maxFrames: 2, width: 640 });
    assert.equal(detail.coverage.resampled, true);
    assert.equal(detail.frames[0].width, 320, 'source detail never upscales');
    assert.equal(detail.frames[0].atSeconds, 1, 'sparse source reports decoded time, not requested 0.3s');

    const captions = [
      { id: 'intro', start: 0.2, end: 0.8, text: 'Restore' },
      { id: 'next', start: 1.2, end: 3.8, text: 'Keep original footage', focusChunks: ['Keep original footage'] },
    ];
    await editProduction(config, { baseRevision: 1, operations: [{ deliverable: 'demo', set: { captions } }] }, opts);
    const repaired = await runProduction(config, opts);
    assert.equal(repaired.machineStatus, 'publish-ready', fs.readFileSync(repaired.manifest, 'utf8'));
    assert.equal(repaired.metrics.executedProducers, 0);
    assert.equal(repaired.metrics.reusedProducers, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'executions'), 'utf8'), 'x');
    assert.equal(evidenceState(repaired.outDir).publishable, false);
    const runDir = path.dirname(repaired.manifest);
    const report = JSON.parse(fs.readFileSync(repaired.manifest));
    const measured = report.files.find((asset) => asset.id === 'demo');
    assert.ok(measured.qa.captions.samples.length >= 8);
    assert.ok(measured.qa.captions.samples.some((sample) => sample.activeWordIndex === 2));
    const video = path.join(runDir, measured.path);
    const captionDirectory = path.join(runDir, 'deliverables/demo-captions');
    assert.deepEqual(fs.readdirSync(captionDirectory).sort(), ['timeline.json'], 'successful production retains the timeline and removes scratch PNG/concat files');
    const timeline = JSON.parse(fs.readFileSync(path.join(captionDirectory, 'timeline.json')));
    assert.equal(timeline.style.mode, 'focus');
    assert.equal(timeline.style.appearance, 'outline');
    assert.equal(timeline.style.bottomOffset, 380);
    assert.ok(timeline.frames.some((frame) => frame.activeWordIndex === 2));
    const sample = (at) => ffmpeg(['-ss', String(at), '-i', video, '-vf', 'crop=720:90:0:850', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.ok(sample(0.4).some((value) => value > 200), 'caption appears between 1fps source frames');
    assert.ok(sample(1).every((value) => value < 40), 'caption disappears between intervals');
    assert.notDeepEqual(sample(1.2), sample(1.4), 'shared word-pop animation moves within a word');
    assert.notDeepEqual(sample(1.5), sample(1.8), 'active word changes');
    assert.equal(evidenceState(repaired.outDir).editorialReview.status, 'pending');
    assert.equal(evidenceState(repaired.outDir).humanApprovalReady, false);
    const review = reviewContext(config, { ...opts, maxFrames: 4 });
    assert.equal(review.video.path, video, 'critique inspects the final composition');
    assert.equal(review.frames[0].width, 720, 'portrait review keeps native width');
    const again = reviewContext(config, { ...opts, maxFrames: 4 });
    assert.deepEqual(again.frames.map((f) => f.path), review.frames.map((f) => f.path), 'detail cache reused');
    // Test-only simulated reviewer. The engine never creates passing verdicts.
    await recordEditorialReview(config, { reviewDigest: review.reviewDigest, deliverables: [{ id: 'demo', contexts: [review.contextId],
      checks: REVIEW_CRITERIA.map((criterion) => ({ criterion, status: 'pass', reason: 'Synthetic integration test reviewer', frames: review.frames.map((f) => f.id) })) }] }, opts);
    assert.equal(evidenceState(repaired.outDir).humanApprovalReady, true);
    assert.equal(evidenceState(repaired.outDir).publishable, false, 'agent critique never grants user approval');

    // A damaged derived output must not cause another product execution.
    fs.unlinkSync(path.join(runDir, 'deliverables/demo.png'));
    assert.equal(planProduction(config, opts).producers[0].action, 'reuse');
    assert.equal(planProduction(config, opts).deliverables[0].action, 'render');
    const recovered = await runProduction(config, opts);
    assert.equal(recovered.metrics.executedProducers, 0);
    assert.equal(recovered.machineStatus, 'publish-ready');

    // Styles are effective, and ordinary capture honors the saved edit too.
    await editProduction(config, { baseRevision: 2, operations: [{ deliverable: 'demo', set: {
      captionOptions: { activeColor: '#00ff00', bottomOffset: 430, wordsPerChunk: 1 },
      captions: [captions[0], { ...captions[1], focusCues: [0, 1, 2, null].map((word, index) => ({ at: index * 0.4, chunk: 0, word })) }],
    } }] }, opts);
    const restyled = await runProduction(config, opts);
    assert.equal(restyled.machineStatus, 'publish-ready');
    assert.equal(evidenceState(restyled.outDir).editorialReview.status, 'pending', 'new composition needs a fresh critique');
    const restyledTimeline = JSON.parse(fs.readFileSync(path.join(path.dirname(restyled.manifest), 'deliverables/demo-captions/timeline.json')));
    assert.ok(restyledTimeline.frames.some((frame) => frame.text === 'Keep original footage' && frame.activeWordIndex === 2), 'authored phrases override word-count chunking in the rendered track');
    assert.deepEqual(restyledTimeline.frames.filter((frame) => frame.text === 'Keep original footage').map((frame) => frame.activeWordIndex), [0, 1, 2, null], 'custom timing preserves every word highlight');
    assert.ok(restyledTimeline.frames.some((frame) => frame.at === 2.4 && frame.activeWordIndex === null), 'authored cue releases emphasis at the requested output time');
    const restyledSample = (at) => ffmpeg(['-ss', String(at), '-i', path.join(path.dirname(restyled.manifest), 'deliverables/demo.mp4'), '-vf', 'crop=720:90:0:800', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    for (const [start, end] of [[1.3, 1.5], [1.7, 1.9], [2.1, 2.3]]) {
      assert.notDeepEqual(restyledSample(start), restyledSample(end), `each authored word keeps its pop animation at ${start}s`);
    }
    const restyledVideo = path.join(path.dirname(restyled.manifest), 'deliverables/demo.mp4');
    assert.notEqual(sha256File(video), sha256File(restyledVideo));
    const ordinary = await capture(config, opts);
    assert.equal(ordinary.machineStatus, 'publish-ready');
    assert.equal(sha256File(restyledVideo), sha256File(path.join(path.dirname(ordinary.manifest), 'deliverables/demo.mp4')));
    assert.equal(evidenceState(ordinary.outDir).publishable, false);

    const missingVideo = path.join(cwd, 'missing-captions.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=720x1280:r=30:d=21', '-c:v', 'libx264', missingVideo]);
    // Production intermediates are intentionally disposable. Build a separate,
    // isolated QA reference instead of relying on a previous run's scratch PNGs.
    const referenceDirectory = fs.mkdtempSync(path.join(cwd, 'caption-reference-'));
    try {
      const referenceSpec = { ...config.evidence.deliverables[0], captions };
      const input = report.producers.find((producer) => producer.id === 'fixture').assets.find((asset) => asset.id === 'video');
      const composition = videoComposition(referenceSpec, input);
      const reference = await renderCaptionTrack({ captions, options: resolvedCaptionOptions(referenceSpec),
        viewport: composition.profile.viewport, duration: composition.duration, directory: referenceDirectory, cwd });
      const settled = reference.samples.find((entry) => entry.id === 'intro' && entry.phase === 'hold');
      assert.ok(settled, 'reference includes a visible settled caption, not its transparent entrance');
      await assert.rejects(() => verifyCaptionTrack({ bin, video: missingVideo,
        sourceVideo: path.join(runDir, input.path), sourceFilter: composition.sourceFilter,
        samples: [settled], width: composition.width, height: composition.height }), /missing or differs/);
    } finally { cleanupCaptionTrack(referenceDirectory); }
    assert.deepEqual(fs.readdirSync(referenceDirectory), [], 'standalone QA references are cleaned up too');

    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const context = await browser.newContext();
      await installDemoCaptionOverlay(context);
      const page = await context.newPage();
      await page.setContent('<p>Scheduled caption visibility fixture</p>');
      const demo = createDemoController({ page, captions: [{ at: 0.1, text: 'Visible caption' }, { at: 0.4, text: '' }] });
      try {
        await page.waitForTimeout(650);
        assert.equal(await page.locator('#__take-a-repo_demo_caption__').getAttribute('data-visible'), 'false');
        assert.ok(demo.captionMetrics().samples.length > 0);
        assert.deepEqual(analyzeDemoCaptionMetrics(demo.captionMetrics()), []);
      } finally { demo.stop(); }
      await page.setViewportSize({ width: 720, height: 1280 });
      const sentence = 'Keep this sentence together';
      const centered = await page.evaluate(async (text) => window.__takeARepoDemoCaption.show(text, {
        mode: 'focus', appearance: 'outline', position: 'bottom', bottomOffset: 365,
        focusWords: text.split(' '), activeWordIndex: 0, fullText: text,
      }), sentence);
      assert.equal(centered.lineCount, 1, 'centered portrait lane retains the complete sentence at the existing font size');
      assert.equal(centered.fontSize, 42, 'sentence fitting must not silently shrink an unconfigured font');
      assert.equal(centered.overflowX, false);
    } finally { await browser.close(); }
    console.log(JSON.stringify({ ok: true, checks: ['low-fps caption timing', 'decoded caption presence', 'first-render source reuse', 'failed-render observations', 'source detail resampling', 'final composite review and cache', 'approval remains required', 'scheduled hide', 'shared focus motion', 'saved style and authored cues', 'ordinary capture parity', 'poster repair without recapture'], captionQA: measured.qa.captions }));
  } finally {
    if (process.env.TAKE_A_REPO_TEST_KEEP) console.error(`Retained media fixture: ${cwd}`);
    else fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
