const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Ajv = require('ajv');
const { findFfmpeg, ffmpegTimeoutMs } = require('./video');
const { validateVideoPresentation, videoComposition, verifyVideoComposition } = require('./video-composition');
const { resolveChannelProfile } = require('./channels');
const { measureAsset } = require('./evidence-contract');
const { renderDeliverable } = require('./evidence-render');
const { normalizeTypographyOptions } = require('./caption-typography');
const { CAPTION_FPS, captionFrameNumbers, verifyCaptionTrack } = require('./production-caption-qa');

const { buildCaptionFrames, captionStyle, normalizeFocusOptions, splitCaptionWords, DEFAULT_FOCUS_WORD_MS } = require('./demo-caption-focus');
const { analyzeDemoStoryboard } = require('./demo-storyboard');
const { captionSchedule, renderCaptionTrack, cleanupCaptionTrack } = require('./production-captions');
const { validateEditorialBrief } = require('./editorial');

function resolvedCaptionOptions(spec) {
  return { ...(spec.channel ? resolveChannelProfile(spec.channel).captionOptions : {}), ...spec.captionOptions };
}

const projectSchema = require('../schemas/production-project.schema.json');
const validateCaption = new Ajv({ allErrors: true }).compile(projectSchema.definitions.caption);

function validateEditorial(spec) {
  validateEditorialBrief(spec.editorial, spec.trim?.duration);
  validateVideoPresentation(spec);
  const captions = spec.captions ?? [];
  if (!Array.isArray(captions) || captions.length > 40) throw new Error('captions must be an array of at most 40 entries');
  const options = resolvedCaptionOptions(spec);
  if (spec.captionOptions != null && (typeof spec.captionOptions !== 'object' || Array.isArray(spec.captionOptions))) throw new Error('captionOptions must be an object');
  const supported = ['mode', 'appearance', 'position', 'bottomOffset', 'wordsPerChunk', 'wordMs', 'activeColor', 'typography'];
  if (Object.keys(spec.captionOptions || {}).some((key) => !supported.includes(key))) throw new Error('unsupported captionOptions field');
  captionStyle(options);
  normalizeFocusOptions({ ...options, mode: 'focus' });
  const typography = normalizeTypographyOptions(options);
  const minFontSize = typography.minFontSize;
  const maxFontSize = typography.maxFontSize || 96;
  if (captions.length && minFontSize > maxFontSize) throw new Error(`${spec.id}: incompatible typography bounds`);
  if (captions.some((caption) => /\P{ASCII}/u.test(caption?.text || ''))
    && (typography.locale === 'und' || !typography.fonts.length)) {
    throw new Error(`${spec.id}: localized captions require captionOptions.typography.locale and project-local fonts`);
  }
  const ids = new Set();
  let lastEnd = 0;
  for (const caption of captions) {
    if (!validateCaption(caption) || !caption.text.trim() || ids.has(caption.id)
      || caption.end <= caption.start || caption.start < lastEnd) {
      throw new Error(`${spec.id}: captions need unique IDs, nonempty text and ordered non-overlapping time ranges`);
    }
    if (caption.fontSize != null && (caption.fontSize < minFontSize || caption.fontSize > maxFontSize)) {
      throw new Error(`${spec.id}: caption fontSize is outside declared typography bounds`);
    }
    ids.add(caption.id);
    lastEnd = caption.end;
  }
  captionFrameNumbers(captions);
  buildCaptionFrames(captionSchedule(captions), options);
  for (const caption of captions) {
    const readingMs = splitCaptionWords(caption.text, typography.locale).length * (options.wordMs || DEFAULT_FOCUS_WORD_MS);
    if ((caption.end - caption.start) * 1000 + 0.01 < readingMs) throw new Error(`${spec.id}: dense-caption ${caption.id}; allow at least ${readingMs}ms or shorten its copy`);
  }
  if (spec.protectedRegions != null && (!Array.isArray(spec.protectedRegions) || spec.protectedRegions.length > 3
    || spec.protectedRegions.some((r) => !r || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(r[key])) || r.width <= 0 || r.height <= 0))) throw new Error('protectedRegions requires up to three rectangles');
}

async function renderProductionDeliverable(spec, report, runDir, cwd = process.cwd()) {
  if (spec.kind !== 'video') return renderDeliverable(spec, report, runDir);
  validateEditorial(spec);
  const [producerId, assetId] = spec.source.split(':');
  const input = report.producers.find((p) => p.id === producerId)?.assets.find((a) => a.id === assetId);
  if (!input || !input.mediaType.startsWith('video/')) throw new Error(`video source missing: ${spec.source}`);
  const composition = videoComposition(spec, input);
  const { duration, profile, width, height, sourceFilter, thumbnailAt } = composition;
  validateEditorialBrief(spec.editorial, duration);
  const captions = spec.captions ?? [];
  if (captions.some((caption) => caption.end > duration)) throw new Error(`${spec.id}: caption extends past the edited video`);
  if (spec.storyboardLint === false) throw new Error('storyboard-lint-disabled: production captions require storyboard QA');
  if (!captions.length) return renderDeliverable(spec, report, runDir);
  if (input.captionState !== 'none') {
    throw new Error(`${spec.id}: source captions are ${input.captionState || 'unknown'}; new captions require a clean source with producer-declared captionState: none. Existing captions in video pixels cannot be replaced by an overlay; supply or recapture an uncaptioned master.`);
  }
  const optionsResolved = resolvedCaptionOptions(spec);
  const warnings = analyzeDemoStoryboard({ captions: captionSchedule(captions).map((c) => ({ at: c.atMs / 1000, text: c.text })), captionOptions: optionsResolved, trim: { duration }, mp4: true }, { viewport: profile.viewport });
  if (warnings.length) throw new Error(warnings.map((warning) => `${warning.code}: ${warning.message}; ${warning.fix}`).join('\n'));
  const dir = path.join(runDir, 'deliverables', `${spec.id}-captions`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const track = await renderCaptionTrack({ captions, options: optionsResolved, viewport: profile.viewport, duration, directory: dir, cwd, protectedRegions: spec.protectedRegions });
    const bin = findFfmpeg();
    if (!bin) throw new Error('production rendering needs ffmpeg');
    const video = path.join(runDir, 'deliverables', `${spec.id}.mp4`);
    const poster = path.join(runDir, 'deliverables', `${spec.id}.png`);
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path.join(runDir, input.path)];
    args.push('-f', 'concat', '-safe', '0', '-i', track.concat);
    const filter = `[0:v]${sourceFilter}[base];[1:v]fps=${CAPTION_FPS},format=rgba[captions];[base][captions]overlay=0:0:format=auto,format=yuv420p[out]`;
    args.push('-filter_complex', filter, '-map', '[out]', '-an', '-t', String(duration), '-r', String(CAPTION_FPS), '-c:v', 'libx264', '-crf', String(profile.mp4.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video);
    const options = { stdio: ['ignore', 'ignore', 'pipe'], timeout: ffmpegTimeoutMs(), killSignal: 'SIGKILL' };
    execFileSync(bin, args, options);
    const measured = measureAsset(runDir, { id: spec.id, path: path.relative(runDir, video), mediaType: 'video/mp4', role: 'recording', captionState: 'burned-in' });
    const qa = measured.qa;
    verifyVideoComposition(qa, composition);
    qa.captions = await verifyCaptionTrack({ bin, video, sourceVideo: path.join(runDir, input.path), sourceFilter, samples: track.samples, width, height });
    const timelineFile = path.join(dir, 'timeline.json');
    fs.writeFileSync(timelineFile, JSON.stringify({ version: 1, fps: CAPTION_FPS, style: captionStyle(optionsResolved), frames: track.timeline, measurements: track.metrics }, null, 2));
    execFileSync(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(thumbnailAt), '-i', video, '-frames:v', '1', poster], options);
    return [measured,
      measureAsset(runDir, { id: `${spec.id}-poster`, path: path.relative(runDir, poster), mediaType: 'image/png', role: 'screenshot' }),
      measureAsset(runDir, { id: `${spec.id}-captions`, path: path.relative(runDir, timelineFile), mediaType: 'application/json', role: 'caption-timeline' }),
    ];
  } finally { cleanupCaptionTrack(dir); }
}

module.exports = { resolvedCaptionOptions, validateEditorial, renderProductionDeliverable };
