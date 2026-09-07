const { buildPublishPlan } = require('../src/publish');

function asset(role, name, extra = {}) {
  return {
    id: `${role}:${name}`,
    name,
    role,
    path: `store-assets/${name}`,
    outPath: name,
    state: 'produced',
    source: { kind: 'demo', name },
    ...extra,
  };
}

function storyboard(warnings = []) {
  return {
    demos: [{ name: 'skillbridge-x', story: 'skillbridge', target: 'x' }],
    storyboardLint: [{ name: 'skillbridge-x', ok: warnings.length === 0, warnings }],
  };
}

describe('autonomous publish plan', () => {
  test('marks a fully probed variant technically publish-ready for user review', () => {
    const plan = buildPublishPlan({
      storyboard: storyboard(),
      run: {},
      assets: [
        asset('sns-demo-mp4', 'skillbridge-x', {
          media: {
            ok: true,
            codec: 'h264',
            pixelFormat: 'yuv420p',
            width: 1280,
            height: 720,
            durationSeconds: 30,
          },
        }),
        asset('thumbnail', 'skillbridge-x', {
          visual: { ok: true, width: 1280, height: 720, nonBlank: true, colorBuckets: 48 },
        }),
      ],
    });

    expect(plan).toMatchObject({
      policy: 'exception-only',
      status: 'publish-ready',
      manualFallback: false,
      userActionRequired: false,
      targets: [{ target: 'x', status: 'publish-ready' }],
      actions: [],
    });
    expect(plan.targets[0].checks.every((check) => check.status === 'pass')).toBe(true);
  });

  test('rejects a nonblank thumbnail that does not match the channel dimensions', () => {
    const plan = buildPublishPlan({
      storyboard: storyboard(),
      assets: [
        asset('sns-demo-mp4', 'skillbridge-x', {
          media: {
            ok: true,
            codec: 'h264',
            pixelFormat: 'yuv420p',
            width: 1280,
            height: 720,
            durationSeconds: 30,
          },
        }),
        asset('thumbnail', 'skillbridge-x', {
          visual: { ok: true, width: 32, height: 32, nonBlank: true, colorBuckets: 48 },
        }),
      ],
    });

    expect(plan).toMatchObject({
      status: 'needs-fix',
      actions: [expect.objectContaining({ code: 'wrong-thumbnail-dimensions', owner: 'agent' })],
    });
  });

  test('turns media and story failures into agent-owned retry actions', () => {
    const plan = buildPublishPlan({
      storyboard: storyboard([{
        code: 'late-first-caption',
        severity: 'warning',
        message: 'first caption starts after 3s',
        fix: 'show the result sooner',
      }]),
      run: {},
      assets: [
        asset('sns-demo-mp4', 'skillbridge-x', {
          media: {
            ok: true,
            codec: 'vp9',
            pixelFormat: 'yuv444p',
            width: 720,
            height: 1280,
            durationSeconds: 8,
          },
        }),
      ],
    });

    expect(plan.status).toBe('needs-fix');
    expect(plan.userActionRequired).toBe(false);
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'wrong-video-codec', owner: 'agent' }),
      expect.objectContaining({ code: 'wrong-channel-dimensions', owner: 'agent' }),
      expect.objectContaining({ code: 'storyboard:late-first-caption', owner: 'agent' }),
      expect.objectContaining({ code: 'missing-publish-thumbnail', owner: 'agent' }),
    ]));
    expect(plan.retryScenes).toEqual(['skillbridge-x']);
  });

  test('does not declare a target publish-ready when storyboard lint is disabled', () => {
    const unlinted = storyboard();
    unlinted.demos[0].lintEnabled = false;
    const plan = buildPublishPlan({
      storyboard: unlinted,
      assets: [
        asset('sns-demo-mp4', 'skillbridge-x', {
          media: {
            ok: true,
            codec: 'h264',
            pixelFormat: 'yuv420p',
            width: 1280,
            height: 720,
            durationSeconds: 30,
          },
        }),
        asset('thumbnail', 'skillbridge-x', {
          visual: { ok: true, width: 1280, height: 720, nonBlank: true, colorBuckets: 48 },
        }),
      ],
    });

    expect(plan).toMatchObject({
      status: 'needs-fix',
      actions: [expect.objectContaining({ code: 'storyboard-lint-disabled', owner: 'agent' })],
    });
  });

  test('creates retry actions when configured targets produced no storyboard', () => {
    const plan = buildPublishPlan({
      storyboard: { demos: [], storyboardLint: [] },
      run: {
        configuredTargetDemos: [{ name: 'skillbridge-x', story: 'skillbridge', target: 'x' }],
      },
      assets: [],
    });

    expect(plan).toMatchObject({
      status: 'needs-fix',
      actions: [{
        code: 'target-output-missing',
        owner: 'agent',
        demo: 'skillbridge-x',
        target: 'x',
      }],
    });
  });

  test('does not shrink whole-pack approval scope during a target-only run', () => {
    const plan = buildPublishPlan({
      storyboard: storyboard(),
      run: {
        requestedTargets: ['x'],
        configuredTargetDemos: [
          { name: 'skillbridge-x', story: 'skillbridge', target: 'x' },
          { name: 'skillbridge-youtube-shorts', story: 'skillbridge', target: 'youtube-shorts' },
        ],
      },
      assets: [
        asset('sns-demo-mp4', 'skillbridge-x', {
          media: {
            ok: true,
            codec: 'h264',
            pixelFormat: 'yuv420p',
            width: 1280,
            height: 720,
            durationSeconds: 30,
          },
        }),
        asset('thumbnail', 'skillbridge-x', {
          visual: { ok: true, width: 1280, height: 720, nonBlank: true, colorBuckets: 48 },
        }),
      ],
    });

    expect(plan).toMatchObject({
      status: 'needs-fix',
      targets: [{ target: 'x' }],
      actions: [expect.objectContaining({ code: 'target-output-missing', target: 'youtube-shorts' })],
    });
  });

  test('leaves legacy non-target demos outside autonomous publishing', () => {
    expect(buildPublishPlan({
      storyboard: { demos: [{ name: 'legacy' }], storyboardLint: [] },
      run: {},
      assets: [],
    })).toMatchObject({ status: 'not-requested', targets: [], actions: [] });
  });

  test('accepts an omitted storyboard for public API callers', () => {
    expect(buildPublishPlan({})).toMatchObject({ status: 'not-requested', targets: [] });
  });

  test('escalates only after the configured automatic attempts are exhausted', () => {
    const plan = buildPublishPlan({
      storyboard: storyboard(),
      run: { attempt: 3 },
      config: { automation: { maxAttempts: 3 } },
      assets: [],
    });

    expect(plan).toMatchObject({
      status: 'blocked',
      attempt: 3,
      maxAttempts: 3,
      userActionRequired: true,
      targets: [{ status: 'blocked' }],
    });
  });
});
