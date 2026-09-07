/* Convert final target assets and structured lint into an exception-only plan. */

const { resolveChannelProfile } = require('./channels');

function assetRef(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    role: asset.role,
    path: asset.path,
    outPath: asset.outPath,
    state: asset.state,
  };
}

function targetAsset(assets, demoName, role) {
  return assets.find((asset) => (
    asset.role === role && asset.source && asset.source.name === demoName
  ));
}

function failedCheck(code, message, fix, demo, target) {
  return {
    check: { code, status: 'fail', message },
    action: {
      code,
      owner: 'agent',
      demo,
      target,
      fix,
      rerun: { scene: demo, target },
    },
  };
}

function targetPublishPlan({ demo, lint, assets, skipped }) {
  const profile = resolveChannelProfile(demo.target);
  const checks = [];
  const actions = [];
  const fail = (code, message, fix) => {
    const item = failedCheck(code, message, fix, demo.name, demo.target);
    checks.push(item.check);
    actions.push(item.action);
  };
  const pass = (code, message) => checks.push({ code, status: 'pass', message });

  const mp4 = targetAsset(assets, demo.name, 'sns-demo-mp4');
  const thumbnail = targetAsset(assets, demo.name, 'thumbnail');

  if (skipped.has(demo.name)) {
    fail('target-not-captured', `${demo.name} was selected but not captured`, 'rerun this target with video enabled');
  }
  if (!mp4) {
    fail('missing-publish-mp4', 'final H.264 MP4 is missing', 'rerun the target; the channel profile enables MP4 automatically');
  } else if (mp4.state === 'modified') {
    fail('modified-publish-mp4', 'the retained MP4 changed outside take-a-repo', 'recapture this target from the story script');
  } else {
    pass('publish-mp4-present', `final MP4 is ${mp4.state || 'available'}`);
    const media = mp4.media;
    if (!media || !media.ok) {
      fail('media-probe-failed', media && media.error ? media.error : 'final MP4 was not probed', 'install ffprobe (bundled with ffmpeg) or set TAKE_A_REPO_FFPROBE, then rerun');
    } else {
      if (media.codec === 'h264') pass('codec-h264', 'video codec is H.264');
      else fail('wrong-video-codec', `video codec is ${media.codec || 'unknown'}`, 'rerun with the channel profile H.264 encoder');

      if (media.pixelFormat === 'yuv420p') pass('pixel-format-yuv420p', 'pixel format is yuv420p');
      else fail('wrong-pixel-format', `pixel format is ${media.pixelFormat || 'unknown'}`, 'rerun with the channel profile yuv420p output');

      if (media.width === profile.viewport.width && media.height === profile.viewport.height) {
        pass('channel-dimensions', `dimensions match ${profile.viewport.width}x${profile.viewport.height}`);
      } else {
        fail(
          'wrong-channel-dimensions',
          `final dimensions are ${media.width}x${media.height}; expected ${profile.viewport.width}x${profile.viewport.height}`,
          `remove conflicting crop/preset overrides and rerun target ${profile.id}`,
        );
      }

      if (media.durationSeconds == null) {
        fail('missing-media-duration', 'ffprobe did not report duration', 'rerun after verifying the ffprobe installation');
      } else if (media.durationSeconds > profile.maximumDurationSeconds) {
        fail(
          'channel-duration-exceeded',
          `duration ${media.durationSeconds.toFixed(2)}s exceeds ${profile.maximumDurationSeconds}s`,
          `shorten trim.duration for target ${profile.id}`,
        );
      } else if (
        media.durationSeconds < profile.recommendedDurationSeconds.min
        || media.durationSeconds > profile.recommendedDurationSeconds.max
      ) {
        fail(
          'story-duration-outside-target',
          `duration ${media.durationSeconds.toFixed(2)}s is outside ${profile.recommendedDurationSeconds.min}-${profile.recommendedDurationSeconds.max}s`,
          `adjust story pacing or trim.duration for target ${profile.id}`,
        );
      } else {
        pass('story-duration', `duration ${media.durationSeconds.toFixed(2)}s is in target range`);
      }
    }
  }

  if (!thumbnail) {
    fail('missing-publish-thumbnail', 'poster/QA thumbnail is missing', 'rerun; the channel profile enables a thumbnail automatically');
  } else if (thumbnail.state === 'modified') {
    fail('modified-publish-thumbnail', 'the retained thumbnail changed outside take-a-repo', 'regenerate the target thumbnail');
  } else {
    pass('publish-thumbnail-present', 'poster/QA thumbnail is available');
    if (!thumbnail.visual || !thumbnail.visual.ok) {
      fail(
        'thumbnail-qa-failed',
        thumbnail.visual && thumbnail.visual.error ? thumbnail.visual.error : 'thumbnail pixels were not analyzed',
        'regenerate the thumbnail and rerun automated pixel QA',
      );
    } else {
      if (thumbnail.visual.width === profile.viewport.width && thumbnail.visual.height === profile.viewport.height) {
        pass('thumbnail-dimensions', `thumbnail dimensions match ${profile.viewport.width}x${profile.viewport.height}`);
      } else {
        fail(
          'wrong-thumbnail-dimensions',
          `thumbnail dimensions are ${thumbnail.visual.width}x${thumbnail.visual.height}; expected ${profile.viewport.width}x${profile.viewport.height}`,
          `regenerate the thumbnail from the final ${profile.id} video`,
        );
      }
      if (!thumbnail.visual.nonBlank) {
        fail('blank-publish-thumbnail', 'poster/QA thumbnail appears blank or uniform', 'recapture this target after verifying the visible result state');
      } else {
        pass('thumbnail-nonblank', `thumbnail has ${thumbnail.visual.colorBuckets} color buckets`);
      }
    }
  }

  if (demo.lintEnabled === false) {
    fail(
      'storyboard-lint-disabled',
      'storyboard lint is disabled for a publish target',
      'remove storyboardLint:false so story checks run before publication',
    );
  }
  for (const warning of lint.warnings || []) {
    fail(`storyboard:${warning.code}`, warning.message, warning.fix);
  }

  return {
    target: profile.id,
    label: profile.label,
    platform: profile.platform,
    delivery: profile.delivery,
    demo: demo.name,
    story: demo.story || demo.name,
    ...(demo.calibration && demo.calibration.profileHash ? { profileHash: demo.calibration.profileHash } : {}),
    status: actions.length ? 'needs-fix' : 'publish-ready',
    deliverable: assetRef(mp4),
    thumbnail: assetRef(thumbnail),
    checks,
    actions,
    upload: {
      connector: profile.connector,
      requiresAuthorization: true,
      specUrl: profile.specUrl,
    },
  };
}

function buildPublishPlan({ assets = [], storyboard = {}, run = {}, config = {} }) {
  // Selection limits execution, never the approval scope of the merged pack.
  const demos = (storyboard.demos || []).filter((demo) => demo.target);
  const expectedDemos = run.configuredTargetDemos || [];
  const manualFallback = !!(config.automation && config.automation.manualFallback);
  const maxAttempts = Number.isInteger(config.automation && config.automation.maxAttempts)
    && config.automation.maxAttempts > 0
    ? config.automation.maxAttempts
    : 3;
  const attempt = Number.isInteger(run.attempt) && run.attempt > 0 ? run.attempt : 1;
  if (!demos.length && !expectedDemos.length) {
    return {
      policy: 'exception-only',
      status: 'not-requested',
      manualFallback,
      userActionRequired: false,
      maxAttempts,
      attempt,
      targets: [],
      actions: [],
      retryScenes: [],
    };
  }

  const lintByName = new Map((storyboard.storyboardLint || []).map((item) => [item.name, item]));
  const skipped = new Set(run.skippedDemos || []);
  const targets = demos.map((demo) => targetPublishPlan({
    demo,
    lint: lintByName.get(demo.name) || { warnings: [] },
    assets,
    skipped,
  }));
  const actions = targets.flatMap((target) => target.actions);
  const configuredButMissing = expectedDemos.filter((configured) => (
    !targets.some((item) => item.demo === configured.name)
  ));
  for (const configured of configuredButMissing) {
    actions.push({
      code: 'target-output-missing',
      owner: 'agent',
      demo: configured.name,
      target: configured.target,
      fix: `capture configured target ${configured.target} for story ${configured.story}`,
      rerun: { scene: configured.name, target: configured.target },
    });
  }

  const exhausted = actions.length > 0 && attempt >= maxAttempts;
  if (exhausted) {
    for (const target of targets) {
      if (target.status === 'needs-fix') target.status = 'blocked';
    }
  }
  return {
    policy: 'exception-only',
    status: exhausted ? 'blocked' : actions.length ? 'needs-fix' : 'publish-ready',
    manualFallback,
    userActionRequired: exhausted,
    maxAttempts,
    attempt,
    targets,
    actions,
    retryScenes: [...new Set(actions.map((action) => action.demo).filter(Boolean))],
  };
}

module.exports = { buildPublishPlan };
