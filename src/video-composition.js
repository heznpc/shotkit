const Ajv = require('ajv');
const { resolveChannelProfile } = require('./channels');
const { buildVideoFilter } = require('./video');
const schema = require('../schemas/production-project.schema.json');

const OUTPUT_FPS = 30;
const validators = Object.fromEntries(['trim', 'crop', 'zoom', 'thumbnail'].map((field) =>
  [field, new Ajv({ allErrors: true }).compile(schema.definitions[field])]));

// The config and saved-edit paths must reject the same unsupported recipes.
function validateVideoPresentation(spec) {
  for (const [field, validate] of Object.entries(validators)) {
    if (spec[field] != null && !validate(spec[field])) throw new Error(`${spec.id}: invalid ${field}: ${JSON.stringify(validate.errors)}`);
  }
  if (spec.crop || spec.zoom) buildVideoFilter(spec);
  if (spec.thumbnail && spec.trim && spec.thumbnail.at >= spec.trim.duration) throw new Error('thumbnail.at must be inside the edited video');
}

function videoComposition(spec, input) {
  validateVideoPresentation(spec);
  if (spec.fit !== 'contain') throw new Error('video fit must explicitly be contain; author crop/zoom to choose the composition');
  const sourceDuration = input?.qa?.durationSeconds;
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error(`${spec.id}: source video has no measured duration`);
  const start = spec.trim?.start ?? 0;
  const duration = spec.trim?.duration ?? sourceDuration;
  if (start + duration > sourceDuration + 1 / OUTPUT_FPS) throw new Error(`${spec.id}: requested source interval is unavailable; recapture this scene`);
  const profile = resolveChannelProfile(spec.channel);
  if (duration > profile.maximumDurationSeconds) throw new Error(`${spec.id}: channel duration must be 0 < duration <= ${profile.maximumDurationSeconds}s`);
  if (spec.thumbnail && spec.thumbnail.at >= duration) throw new Error('thumbnail.at must be inside the edited video');

  let sourceWidth = input.qa.width, sourceHeight = input.qa.height;
  if (spec.crop || spec.zoom) {
    if (![sourceWidth, sourceHeight].every((value) => Number.isFinite(value) && value >= 2)) throw new Error(`${spec.id}: framing requires measured source dimensions`);
    if (spec.crop) {
      const { x, y, width, height } = spec.crop;
      if (width < 2 || height < 2 || x + width > sourceWidth || y + height > sourceHeight) throw new Error(`${spec.id}: crop is outside the source video`);
      sourceWidth = width; sourceHeight = height;
    }
    if (spec.zoom) {
      const scale = typeof spec.zoom === 'number' ? spec.zoom : spec.zoom.scale;
      if (sourceWidth / scale < 2 || sourceHeight / scale < 2) throw new Error(`${spec.id}: zoom leaves less than two source pixels`);
      for (const [axis, extent] of [['x', sourceWidth], ['y', sourceHeight]]) {
        if (typeof spec.zoom[axis] === 'number' && spec.zoom[axis] + extent / scale > extent) throw new Error(`${spec.id}: zoom.${axis} is outside the cropped source`);
      }
    }
  }
  const { width, height } = profile.viewport;
  const framing = spec.crop || spec.zoom ? `${buildVideoFilter(spec)},` : '';
  // This exact filter is also used to decode QA's background reference. A
  // separate approximation would compare captions against the wrong pixels.
  const sourceFilter = `trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS},${framing}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  return { start, duration, profile, width, height, sourceFilter, fps: OUTPUT_FPS,
    thumbnailAt: spec.thumbnail?.at ?? Math.min(profile.thumbnail.at, duration / 2) };
}

function verifyVideoComposition(qa, composition) {
  const { width, height, duration, profile } = composition;
  if (!qa?.ok || qa.codec !== 'h264' || qa.pixelFormat !== 'yuv420p' || qa.width !== width || qa.height !== height
    || !Number.isFinite(qa.durationSeconds) || qa.durationSeconds <= 0 || qa.durationSeconds > profile.maximumDurationSeconds
    || Math.abs(qa.durationSeconds - duration) > 2 / OUTPUT_FPS + 0.001) {
    throw new Error(`channel QA failed: expected H.264 ${width}x${height}, edited duration ${duration}s`);
  }
}

module.exports = { OUTPUT_FPS, validateVideoPresentation, videoComposition, verifyVideoComposition };
