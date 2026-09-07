const { normalizeDemoCaptions, parseTimeToMs } = require('../demo-time');
const { buildCaptionFrames, buildCaptionTimeline, captionStyle } = require('../demo-caption-focus');

function demoAudience(demoConfig) {
  return demoConfig.audience || demoConfig.channel || 'sns';
}

function demoNextTool(demoConfig) {
  if (demoConfig.targetProfile && demoConfig.targetProfile.connector) {
    return `${demoConfig.targetProfile.connector}-upload`;
  }
  if (demoConfig.nextTool) return demoConfig.nextTool;
  if (demoConfig.handoff && demoConfig.handoff.nextTool) return demoConfig.handoff.nextTool;
  return 'manual-editor';
}

// The delivered mp4/webm has trim.start cut off its head, so caption/beat times
// in the handoff contract must be relative to the DELIVERABLE, not the raw
// recording. Returns 0 unless trim is an object with a parseable start.
function trimStartMs(demoConfig) {
  const trim = demoConfig.trim;
  if (!trim || typeof trim !== 'object' || trim.start == null) return 0;
  try {
    return parseTimeToMs(trim.start, 'trim.start');
  } catch (_e) {
    return 0;
  }
}

function trimEndMs(demoConfig, startMs) {
  const trim = demoConfig.trim;
  if (!trim || typeof trim !== 'object' || trim.duration == null) return null;
  try {
    return startMs + parseTimeToMs(trim.duration, 'trim.duration');
  } catch (_e) {
    return null;
  }
}

// Shift caption times by the trimmed-off prefix and drop captions outside the
// delivered trim window. Output conforms to the beat/caption schema: at >= 0
// (number), atMs >= 0 (integer).
function deliverableBeats(captions, startMs, endMs = null) {
  return captions
    .filter((caption) => caption.atMs >= startMs && (endMs == null || caption.atMs < endMs))
    .map((caption) => ({
      atMs: caption.atMs - startMs,
      text: caption.text,
      ...(caption.role == null ? {} : { role: caption.role }),
    }))
    .map((beat) => ({ at: beat.atMs / 1000, ...beat }));
}

// Coerce loosely-typed demo config into the storyboard schema's shape: preset
// must be a string (object presets are omitted), trim object|null, thumbnail
// object|boolean|null (a bare number becomes { at }).
function storyboardPreset(preset) {
  return typeof preset === 'string' ? preset : undefined;
}

function storyboardTrim(trim) {
  return trim && typeof trim === 'object' ? trim : null;
}

function storyboardThumbnail(thumbnail) {
  if (typeof thumbnail === 'number') return { at: thumbnail };
  return thumbnail || null;
}

function demoStoryboard(demoConfig, viewport) {
  const captions = normalizeDemoCaptions(demoConfig.captions || []);
  const startMs = trimStartMs(demoConfig);
  const endMs = trimEndMs(demoConfig, startMs);
  return {
    name: demoConfig.name,
    story: demoConfig.story,
    target: demoConfig.target,
    lintEnabled: demoConfig.storyboardLint !== false && demoConfig.lint !== false,
    audience: demoAudience(demoConfig),
    channelProfile: demoConfig.targetProfile ? {
      id: demoConfig.targetProfile.id,
      label: demoConfig.targetProfile.label,
      platform: demoConfig.targetProfile.platform,
      delivery: demoConfig.targetProfile.delivery,
      specUrl: demoConfig.targetProfile.specUrl,
    } : undefined,
    preset: storyboardPreset(demoConfig.preset),
    viewport,
    recommendedNextTool: demoNextTool(demoConfig),
    trim: storyboardTrim(demoConfig.trim),
    framing: {
      crop: demoConfig.crop || null,
      zoom: demoConfig.zoom || null,
    },
    calibration: demoConfig.calibrationProfile ? {
      profileHash: demoConfig.calibrationProfile.profileHash,
      layoutPreset: demoConfig.calibrationProfile.layoutPreset,
      protectedRegions: demoConfig.calibrationProfile.protectedRegions || [],
    } : null,
    captionStyle: captionStyle(demoConfig.captionOptions || {}),
    thumbnail: storyboardThumbnail(demoConfig.thumbnail),
    recommendedStory: {
      durationSeconds: { min: 20, max: 40 },
      shape: ['result-first', 'action', 'proof', 'safety-restore'],
    },
    beats: deliverableBeats(captions, startMs, endMs),
    guidance: demoConfig.guidance || null,
  };
}

function finiteSampleValues(samples, key) {
  return samples.map((sample) => sample[key]).filter(Number.isFinite);
}

function captionQaReport(report) {
  if (!report) return undefined;
  const expectedFrames = Array.isArray(report.expectedFrames) ? report.expectedFrames : [];
  const samples = Array.isArray(report.samples) ? report.samples : [];
  const fontSamples = samples.filter((sample) => sample.fontConfigured);
  const fontLoadTimes = finiteSampleValues(fontSamples, 'fontLoadMs');
  const fontSizes = finiteSampleValues(samples, 'fontSize');
  const lineCounts = finiteSampleValues(samples, 'lineCount');
  const lineBalances = finiteSampleValues(samples, 'lineBalance');
  const typographyEnabled = !!(report.typography && report.typography.enabled);
  const allFramesLoaded = samples.length
    ? samples.every((sample) => sample.fontConfigured === true && sample.fontLoaded === true)
    : null;
  return {
    scheduledFrameCount: expectedFrames.length,
    measuredFrameCount: samples.length,
    typography: report.typography || null,
    rendering: {
      fontLoaded: typographyEnabled
        ? allFramesLoaded
        : fontSamples.length ? fontSamples.every((sample) => sample.fontLoaded === true) : null,
      maxFontLoadMs: fontLoadTimes.length ? Math.max(...fontLoadTimes) : null,
      fitStatuses: [...new Set(samples.map((sample) => sample.fitStatus).filter(Boolean))],
      resolvedFontSize: fontSizes.length ? { min: Math.min(...fontSizes), max: Math.max(...fontSizes) } : null,
      maxLineCount: lineCounts.length ? Math.max(...lineCounts) : 0,
      minLineBalance: lineBalances.length ? Math.min(...lineBalances) : null,
    },
  };
}

function demoCaptions(demoConfig, captionReport) {
  const startMs = trimStartMs(demoConfig);
  const endMs = trimEndMs(demoConfig, startMs);
  const captions = normalizeDemoCaptions(demoConfig.captions || []);
  const frames = buildCaptionFrames(captions, demoConfig.captionOptions);
  return {
    name: demoConfig.name,
    story: demoConfig.story,
    target: demoConfig.target,
    style: captionStyle(demoConfig.captionOptions || {}),
    ...(captionReport ? { qa: captionQaReport(captionReport) } : {}),
    captions: deliverableBeats(captions, startMs, endMs),
    timeline: buildCaptionTimeline(frames, { startMs, endMs }),
  };
}

function storyboardLintSummary(warnings) {
  return Object.entries(warnings || {}).map(([name, items]) => ({
    name,
    ok: !items.length,
    warnings: items,
  }));
}

module.exports = {
  demoCaptions,
  demoStoryboard,
  storyboardLintSummary,
};
