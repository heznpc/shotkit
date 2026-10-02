/*
 * Channel profiles are mechanical publishing constraints. Config authors own
 * the story and actions; take-a-repo owns viewport, codec, duration cap, and poster
 * defaults for known destinations.
 */

const CHANNEL_PROFILES = Object.freeze({
  'cws-youtube': Object.freeze({
    id: 'cws-youtube',
    label: 'Chrome Web Store promo video',
    platform: 'chrome-web-store',
    delivery: 'youtube-url',
    preset: 'sns-video',
    viewport: Object.freeze({ width: 1280, height: 720 }),
    mp4: Object.freeze({ crf: 18 }),
    trim: Object.freeze({ duration: 30 }),
    thumbnail: Object.freeze({ at: 1.2 }),
    captionOptions: Object.freeze({ position: 'bottom' }),
    recommendedDurationSeconds: Object.freeze({ min: 20, max: 40 }),
    maximumDurationSeconds: 180,
    outputSuffix: 'cws-youtube',
    connector: 'youtube',
    specUrl: 'https://developer.chrome.com/docs/webstore/cws-dashboard-listing',
  }),
  x: Object.freeze({
    id: 'x',
    label: 'X post video',
    platform: 'x',
    delivery: 'social-upload',
    preset: 'sns-video',
    viewport: Object.freeze({ width: 1280, height: 720 }),
    mp4: Object.freeze({ crf: 18 }),
    trim: Object.freeze({ duration: 30 }),
    thumbnail: Object.freeze({ at: 1.2 }),
    captionOptions: Object.freeze({ position: 'bottom' }),
    recommendedDurationSeconds: Object.freeze({ min: 20, max: 40 }),
    maximumDurationSeconds: 140,
    outputSuffix: 'x',
    connector: 'x',
    specUrl: 'https://help.x.com/en/using-x/x-videos',
  }),
  'youtube-shorts': Object.freeze({
    id: 'youtube-shorts',
    label: 'YouTube Short',
    platform: 'youtube',
    delivery: 'youtube-short',
    preset: 'sns-vertical',
    viewport: Object.freeze({ width: 720, height: 1280 }),
    mp4: Object.freeze({ crf: 18 }),
    trim: Object.freeze({ duration: 30 }),
    thumbnail: Object.freeze({ at: 1.2 }),
    captionOptions: Object.freeze({
      position: 'bottom-left',
      mode: 'focus',
      appearance: 'outline',
      wordsPerChunk: 3,
      wordMs: 360,
      activeColor: '#facc15',
      bottomOffset: 380,
    }),
    recommendedDurationSeconds: Object.freeze({ min: 20, max: 40 }),
    maximumDurationSeconds: 180,
    outputSuffix: 'youtube-shorts',
    connector: 'youtube',
    specUrl: 'https://support.google.com/youtube/answer/15424877',
  }),
});

function resolveChannelProfile(id) {
  if (typeof id !== 'string' || !Object.hasOwn(CHANNEL_PROFILES, id)) {
    throw new Error(`take-a-repo: unknown channel target "${id}". Known: ${Object.keys(CHANNEL_PROFILES).join(', ')}`);
  }
  return CHANNEL_PROFILES[id];
}

function targetIds(demo) {
  if (demo.targets == null && demo.target == null) return [];
  const values = demo.targets == null ? [demo.target] : demo.targets;
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value)) {
    throw new Error(`take-a-repo: demo "${demo.name || '(unnamed)'}".targets must be a non-empty string array`);
  }
  return [...new Set(values)];
}

function validateTargetOptions(demo, ids) {
  if (demo.targetOptions == null) return;
  if (typeof demo.targetOptions !== 'object' || Array.isArray(demo.targetOptions)) {
    throw new Error(`take-a-repo: demo "${demo.name}".targetOptions must be an object`);
  }
  const unknown = Object.keys(demo.targetOptions).filter((id) => !ids.includes(id));
  if (unknown.length) {
    throw new Error(`take-a-repo: demo "${demo.name}".targetOptions contains undeclared target: ${unknown.join(', ')}`);
  }
  for (const [id, options] of Object.entries(demo.targetOptions)) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error(`take-a-repo: demo "${demo.name}".targetOptions.${id} must be an object`);
    }
  }
}

function expandDemoTargets(demo) {
  const ids = targetIds(demo);
  if (!ids.length) return [demo];
  validateTargetOptions(demo, ids);
  return ids.map((id) => {
    const profile = resolveChannelProfile(id);
    const override = demo.targetOptions && demo.targetOptions[id] ? demo.targetOptions[id] : {};
    return {
      ...demo,
      ...override,
      name: override.name || `${demo.name}-${profile.outputSuffix}`,
      story: demo.story || demo.name,
      target: profile.id,
      channel: profile.platform,
      preset: override.preset || profile.preset,
      mp4: override.mp4 || demo.mp4 || profile.mp4,
      trim: { ...profile.trim, ...(demo.trim || {}), ...(override.trim || {}) },
      thumbnail: override.thumbnail || demo.thumbnail || profile.thumbnail,
      captionOptions: {
        ...profile.captionOptions,
        ...(demo.captionOptions || {}),
        ...(override.captionOptions || {}),
      },
      targetProfile: profile,
    };
  });
}

module.exports = { CHANNEL_PROFILES, expandDemoTargets, resolveChannelProfile };
