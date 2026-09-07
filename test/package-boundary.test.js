const pkg = require('../package.json');
const publicApi = require('../src');

describe('npm package boundary', () => {
  test('ships the public capture and handoff surface only', () => {
    expect(pkg.files).toEqual([
      'src',
      'bin',
      'calibrator',
      'campaign',
      'skills/capture',
      'skills/demo',
      'skills/launch-proof',
      'examples/evidence',
      'docs/evidence.md',
      'docs/handoff-conventions.md',
      'schemas',
    ]);
  });

  test('keeps repo-internal research and application planning out of the tarball', () => {
    expect(pkg.files).not.toContain('skills/research-to-product-fit');
    expect(pkg.files).not.toContain('research-runs');
    expect(pkg.files).not.toContain('examples');
    expect(pkg.files).not.toContain('docs');
  });

  test('exports the root API and schema subpath contract', () => {
    expect(pkg.exports).toEqual({
      '.': './src/index.js',
      './schemas/*': './schemas/*',
    });
  });

  test('locks the public root API names', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'CHANNEL_PROFILES',
      'DEFAULT_BAND_HEIGHT',
      'DEFAULT_TARGETS',
      'DEFAULT_VIEWPORT',
      'FIXTURE_CSP',
      'HANDOFF_KINDS',
      'HANDOFF_SCHEMA_IDS',
      'HANDOFF_VERSION',
      'LOCALHOST_MATCHES',
      'PRESETS',
      'analyzeDemoStoryboard',
      'applyCalibrationProfiles',
      'assetRecord',
      'buildFfmpegArgs',
      'buildHandoffDocs',
      'buildHandoffRecommendations',
      'buildPublishPlan',
      'buildQuickDemoConfig',
      'buildThumbnailArgs',
      'buildVideoFilter',
      'calibrationProfileHash',
      'capture',
      'closeContext',
      'compositeCaption',
      'createDemoController',
      'demoCaptionInitScript',
      'demoStoryboard',
      'ensureDemoCaptionOverlay',
      'extractListing',
      'extractPrivacyDisclosure',
      'extractProductListing',
      'extractProductManifest',
      'findFfmpeg',
      'formatStoryboardLint',
      'hideDemoCaption',
      'hideDemoPointer',
      'installDemoCaptionOverlay',
      'launchBrowser',
      'launchWithExtension',
      'lintDemoStoryboard',
      'loadCalibration',
      'makeQuickDemoRun',
      'moveDemoPointer',
      'normalizeDelayMs',
      'normalizeDemoCaptions',
      'normalizeDemoConfigs',
      'parseTimeToMs',
      'patchManifestForLocalhost',
      'postProcessDemo',
      'pulseDemoPointer',
      'renderDescriptionDoc',
      'renderPrivacyDisclosureDoc',
      'renderPromoTile',
      'resolveChannelProfile',
      'resolveDemoTarget',
      'resolveSize',
      'serveDirectory',
      'setDemoCaption',
      'splitSections',
      'stageExtension',
      'startCalibrator',
      'updateCalibrationProfile',
      'writeHandoffDocs',
    ]);
  });
});
