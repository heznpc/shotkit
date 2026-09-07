const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  recaptureCliArgs,
  safeCampaignStaticPath,
  safeStaticPath,
  startCalibrator,
} = require('../src/calibrator-server');

const { createHash } = require('crypto');
const DIGEST = createHash('sha256').update('0123456789').digest('hex');

function luminance(hex) {
  const channels = hex.match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function cssColor(css, name) {
  return css.match(new RegExp(`--${name}: #([0-9a-f]{6})`, 'i'))[1];
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function projectFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-calibrator-'));
  const outDir = path.join(cwd, 'store-assets');
  const name = 'demo-youtube-shorts';
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, `${name}.mp4`), Buffer.from('0123456789'));
  writeJson(path.join(outDir, 'take-a-repo-manifest.json'), {
    assets: [{
      id: `sns-demo-mp4:${name}`,
      role: 'sns-demo-mp4',
      type: 'video',
      outPath: `${name}.mp4`,
      source: { kind: 'demo', name, story: 'demo', target: 'youtube-shorts' },
      integrity: { algorithm: 'sha256', digest: DIGEST },
    }],
    handoff: {
      automation: {
        attempt: 1,
        status: 'publish-ready',
        targets: [{
          demo: name,
          story: 'demo',
          target: 'youtube-shorts',
          status: 'publish-ready',
          deliverable: { id: `sns-demo-mp4:${name}` },
        }],
      },
    },
  });
  writeJson(path.join(outDir, 'storyboard.json'), {
    demos: [{
      name,
      viewport: { width: 720, height: 1280 },
      beats: [{ at: 1.2, text: 'Show the result' }],
    }],
    storyboardLint: [{ name, warnings: [] }],
  });
  writeJson(path.join(outDir, 'captions.json'), { demos: [] });
  const config = {
    outDir: 'store-assets',
    calibration: { from: 'take-a-repo.calibration.json', layouts: ['focus-column', 'compact-column'] },
    demos: [{ name: 'demo', targets: ['youtube-shorts'], run: async () => {} }],
  };
  return { cwd, config, name };
}

function multiTargetFixture() {
  const fixture = projectFixture();
  const outDir = path.join(fixture.cwd, 'store-assets');
  const xName = 'demo-x';
  const xDigest = createHash('sha256').update('x-video').digest('hex');
  fs.writeFileSync(path.join(outDir, `${xName}.mp4`), Buffer.from('x-video'));
  const manifestPath = path.join(outDir, 'take-a-repo-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.assets.push({
    id: `sns-demo-mp4:${xName}`,
    role: 'sns-demo-mp4',
    type: 'video',
    outPath: `${xName}.mp4`,
    source: { kind: 'demo', name: xName, story: 'demo', target: 'x' },
    integrity: { algorithm: 'sha256', digest: xDigest },
  });
  manifest.handoff.automation.targets.push({
    demo: xName,
    story: 'demo',
    target: 'x',
    status: 'publish-ready',
    deliverable: { id: `sns-demo-mp4:${xName}` },
  });
  writeJson(manifestPath, manifest);
  const storyboardPath = path.join(outDir, 'storyboard.json');
  const storyboard = JSON.parse(fs.readFileSync(storyboardPath, 'utf8'));
  storyboard.demos.push({ name: xName, viewport: { width: 1280, height: 720 }, beats: [] });
  storyboard.storyboardLint.push({ name: xName, warnings: [] });
  writeJson(storyboardPath, storyboard);
  fixture.config.demos[0].targets = ['youtube-shorts', 'x'];
  return { ...fixture, xDigest };
}

describe('calibrator server', () => {
  test('builds campaign captures while keeping calibrator recaptures build-free', () => {
    const base = {
      cwd: '/tmp/project',
      configPath: '/tmp/project/take-a-repo.config.js',
      story: 'demo',
      target: 'youtube-shorts',
      attempt: 2,
    };
    const campaignArgs = recaptureCliArgs({
      ...base,
      targets: ['youtube-shorts', 'x'],
      noBuild: false,
    });
    const calibratorArgs = recaptureCliArgs({ ...base, noBuild: true });

    expect(campaignArgs).not.toContain('--no-build');
    expect(campaignArgs).toEqual(expect.arrayContaining([
      '--target', 'youtube-shorts,x', '--attempt', '2',
    ]));
    expect(calibratorArgs).toContain('--no-build');
  });

  test('confines static paths and rejects malformed encodings', () => {
    const staticRoot = path.dirname(safeStaticPath('/'));
    const traversal = safeStaticPath('/%2e%2e/%2e%2e/package.json');
    expect(traversal.startsWith(`${staticRoot}${path.sep}`)).toBe(true);
    expect(safeStaticPath('/%E0%A4%A')).toBeNull();
    expect(safeStaticPath('/%00')).toBeNull();
    const campaignRoot = path.dirname(safeCampaignStaticPath('/campaign/'));
    const campaignTraversal = safeCampaignStaticPath('/campaign/%2e%2e/%2e%2e/package.json');
    expect(campaignTraversal.startsWith(`${campaignRoot}${path.sep}`)).toBe(true);
    expect(safeCampaignStaticPath('/campaign/%E0%A4%A')).toBeNull();
  });

  test.each(['calibrator', 'campaign'])('%s static DOM keeps every JavaScript id binding valid', (surface) => {
    const root = path.join(__dirname, '..', surface);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const script = fs.readdirSync(root)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
      .join('\n');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const bindings = [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
    for (const binding of bindings) expect(ids).toContain(binding);
  });

  test.each(['calibrator', 'campaign'])('%s keeps selection controls native and motion optional', (surface) => {
    const root = path.join(__dirname, '..', surface);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    const script = fs.readdirSync(root)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
      .join('\n');

    expect(html).not.toMatch(/\srole="(?:listbox|option|radiogroup|radio|tablist|tab)"/);
    expect(script).not.toMatch(/setAttribute\('role', '(?:option|radio|tab|button)'\)/);
    expect(script).not.toMatch(/setAttribute\('aria-(?:checked|selected)'/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(contrast(cssColor(css, 'accent'), 'ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(cssColor(css, 'muted'), cssColor(css, 'panel'))).toBeGreaterThanOrEqual(4.5);
  });

  test('adds a campaign workflow while preserving the calibrator and approval APIs', async () => {
    const { cwd, config } = projectFixture();
    const campaignConfig = { ...config, calibration: undefined };
    const captureTarget = jest.fn(async () => ({
      ok: true,
      status: 'awaiting-approval',
      machineStatus: 'publish-ready',
      produced: [],
    }));
    const calibrator = await startCalibrator({
      cwd,
      config: campaignConfig,
      configPath: path.join(cwd, 'take-a-repo.config.js'),
      port: 0,
      open: false,
      view: 'campaign',
      captureTarget,
    });

    try {
      const root = await fetch(calibrator.url).then((response) => response.text());
      expect(root).toContain('<title>take-a-repo Calibrator</title>');
      expect(root).toContain('href="/campaign/"');
      const redirect = await fetch(`${calibrator.url}/campaign`, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('/campaign/');
      const dashboard = await fetch(calibrator.campaignUrl).then((response) => response.text());
      expect(dashboard).toContain('<title>take-a-repo Campaigns</title>');
      expect(dashboard).toContain('href="/"');
      for (const [assetPath, contentType] of [
        ['/styles.css', 'text/css'],
        ['/app.js', 'text/javascript'],
        ['/model.js', 'text/javascript'],
        ['/preview.js', 'text/javascript'],
        ['/regions.js', 'text/javascript'],
        ['/campaign/styles.css', 'text/css'],
        ['/campaign/app.js', 'text/javascript'],
        ['/campaign/api.js', 'text/javascript'],
        ['/campaign/model.js', 'text/javascript'],
        ['/campaign/render.js', 'text/javascript'],
      ]) {
        const response = await fetch(`${calibrator.url}${assetPath}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(contentType);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      }

      const initial = await fetch(`${calibrator.url}/api/campaign`).then((response) => response.json());
      expect(initial).toMatchObject({
        version: 1,
        project: path.basename(cwd),
        phase: 'plan',
        calibratorAvailable: false,
        calibratorUrl: null,
        recipes: [{
          id: 'demo',
          story: 'demo',
          targets: [expect.objectContaining({ id: 'youtube-shorts', status: 'awaiting-approval' })],
        }],
        selection: { recipeId: 'demo', persisted: false },
        run: { status: 'idle' },
      });

      const started = await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: 'demo' }),
      });
      expect(started.status).toBe(202);

      let campaign;
      for (let index = 0; index < 20; index++) {
        campaign = await fetch(`${calibrator.url}/api/campaign`).then((response) => response.json());
        if (campaign.run.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(campaign).toMatchObject({
        phase: 'review',
        selection: { recipeId: 'demo', targets: ['youtube-shorts'], persisted: true },
        run: {
          status: 'completed',
          targets: [{ target: 'youtube-shorts', status: 'publish-ready' }],
        },
        summary: { selected: 1, publishReady: 1, reviewable: 1, approved: 0 },
      });
      expect(captureTarget).toHaveBeenCalledWith(expect.objectContaining({
        cwd,
        story: 'demo',
        targets: ['youtube-shorts'],
        noBuild: false,
        attempt: 2,
      }));
      expect(fs.existsSync(path.join(cwd, 'take-a-repo.calibration.json'))).toBe(false);

      const approved = await fetch(`${calibrator.url}/api/campaign/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeId: 'demo',
          candidates: [{ target: 'youtube-shorts', assetDigest: DIGEST }],
          status: 'approved',
        }),
      }).then((response) => response.json());
      expect(approved).toMatchObject({
        ok: true,
        campaign: { phase: 'complete', summary: { approved: 1 } },
      });
    } finally {
      await calibrator.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('rejects unsafe write requests and media paths without side effects', async () => {
    const { cwd, config } = projectFixture();
    const captureTarget = jest.fn(async () => ({ machineStatus: 'publish-ready' }));
    const calibrator = await startCalibrator({
      cwd,
      config,
      configPath: path.join(cwd, 'take-a-repo.config.js'),
      port: 0,
      open: false,
      view: 'campaign',
      captureTarget,
    });

    try {
      const html = await fetch(calibrator.campaignUrl);
      expect(html.headers.get('content-security-policy')).toContain("default-src 'self'");

      const wrongType = await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(wrongType.status).toBe(415);

      const crossOrigin = await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' },
        body: JSON.stringify({ recipeId: 'demo' }),
      });
      expect(crossOrigin.status).toBe(403);

      const rebindingStatus = await new Promise((resolve, reject) => {
        const request = http.get(`${calibrator.url}/api/campaign`, { headers: { Host: 'example.invalid' } }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
      });
      expect(rebindingStatus).toBe(403);

      const malformed = await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(malformed.status).toBe(400);

      const oversized = await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: 'demo', padding: 'x'.repeat(300_000) }),
      });
      expect(oversized.status).toBe(413);

      const malformedMedia = await fetch(`${calibrator.url}/media/%E0%A4%A`);
      expect(malformedMedia.status).toBe(400);
      const outside = path.join(os.tmpdir(), `take-a-repo-outside-${Date.now()}.mp4`);
      fs.writeFileSync(outside, 'outside');
      fs.symlinkSync(outside, path.join(cwd, 'store-assets', 'outside.mp4'));
      expect((await fetch(`${calibrator.url}/media/outside.mp4`)).status).toBe(404);
      fs.rmSync(outside, { force: true });

      expect(captureTarget).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(cwd, 'store-assets', 'take-a-repo-campaign.json'))).toBe(false);
    } finally {
      await calibrator.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('does not verify a calibration profile changed during capture', async () => {
    const { cwd, config } = projectFixture();
    let finishCapture;
    const captureTarget = jest.fn(() => new Promise((resolve) => { finishCapture = resolve; }));
    const calibrator = await startCalibrator({
      cwd,
      config,
      configPath: path.join(cwd, 'take-a-repo.config.js'),
      port: 0,
      open: false,
      view: 'campaign',
      captureTarget,
    });

    try {
      const profile = {
        layoutPreset: 'focus-column',
        framing: { scale: 1.04, focusX: 0.5, focusY: 0.45 },
        captionOptions: { position: 'bottom-left', appearance: 'outline', bottomOffset: 80 },
        protectedRegions: [],
      };
      expect((await fetch(`${calibrator.url}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story: 'demo', target: 'youtube-shorts', profile }),
      })).status).toBe(200);

      expect((await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: 'demo' }),
      })).status).toBe(202);
      expect(captureTarget).toHaveBeenCalledTimes(1);

      const blockedProfile = await fetch(`${calibrator.url}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story: 'demo',
          target: 'youtube-shorts',
          profile: { ...profile, captionOptions: { ...profile.captionOptions, bottomOffset: 120 } },
        }),
      });
      expect(blockedProfile.status).toBe(409);

      const calibrationPath = path.join(cwd, 'take-a-repo.calibration.json');
      const calibration = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
      calibration.profiles.demo['youtube-shorts'] = {
        ...profile,
        captionOptions: { ...profile.captionOptions, bottomOffset: 160 },
      };
      writeJson(calibrationPath, calibration);
      finishCapture({ ok: true, status: 'awaiting-approval', machineStatus: 'publish-ready' });

      let campaign;
      for (let index = 0; index < 20; index++) {
        campaign = await fetch(`${calibrator.url}/api/campaign`).then((response) => response.json());
        if (campaign.run.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(campaign.run.status).toBe('needs-fix');
      const saved = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'))
        .profiles.demo['youtube-shorts'];
      expect(saved.captionOptions.bottomOffset).toBe(160);
      expect(saved.verification).toBeUndefined();
    } finally {
      await calibrator.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('runs a recipe in one attempt and rejects an atomic review when any candidate is stale', async () => {
    const { cwd, config, xDigest } = multiTargetFixture();
    const campaignConfig = { ...config, calibration: undefined };
    const captureTarget = jest.fn(async () => ({
      ok: true,
      status: 'awaiting-approval',
      machineStatus: 'publish-ready',
    }));
    const calibrator = await startCalibrator({
      cwd,
      config: campaignConfig,
      configPath: path.join(cwd, 'take-a-repo.config.js'),
      port: 0,
      open: false,
      view: 'campaign',
      captureTarget,
    });

    try {
      await fetch(`${calibrator.url}/api/campaign/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: 'demo' }),
      });
      let campaign;
      for (let index = 0; index < 20; index++) {
        campaign = await fetch(`${calibrator.url}/api/campaign`).then((response) => response.json());
        if (campaign.run.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(campaign.run).toMatchObject({ status: 'completed', attempt: 2 });
      expect(captureTarget).toHaveBeenCalledTimes(1);
      expect(captureTarget).toHaveBeenCalledWith(expect.objectContaining({
        targets: ['youtube-shorts', 'x'],
        attempt: 2,
      }));

      const stale = await fetch(`${calibrator.url}/api/campaign/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeId: 'demo',
          status: 'approved',
          candidates: [
            { target: 'youtube-shorts', assetDigest: DIGEST },
            { target: 'x', assetDigest: 'c'.repeat(64) },
          ],
        }),
      });
      expect(stale.status).toBe(409);
      expect(fs.existsSync(path.join(cwd, 'store-assets', 'take-a-repo-approval.json'))).toBe(false);

      const approved = await fetch(`${calibrator.url}/api/campaign/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeId: 'demo',
          status: 'approved',
          candidates: [
            { target: 'youtube-shorts', assetDigest: DIGEST },
            { target: 'x', assetDigest: xDigest },
          ],
        }),
      });
      expect(approved.status).toBe(200);
      const decisions = JSON.parse(fs.readFileSync(
        path.join(cwd, 'store-assets', 'take-a-repo-approval.json'),
        'utf8',
      )).decisions.demo;
      expect(Object.keys(decisions).sort()).toEqual(['x', 'youtube-shorts']);
    } finally {
      await calibrator.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reads capture state, serves media ranges, and persists an unverified profile', async () => {
    const { cwd, config, name } = projectFixture();
    const calibrator = await startCalibrator({
      cwd,
      config,
      configPath: path.join(cwd, 'take-a-repo.config.js'),
      port: 0,
      open: false,
    });

    try {
      const initial = await fetch(`${calibrator.url}/api/state`).then((response) => response.json());
      expect(initial.targets).toEqual([expect.objectContaining({
        story: 'demo',
        target: 'youtube-shorts',
        name,
        status: 'needs-fix',
        machineStatus: 'publish-ready',
        hasProfile: false,
        verified: false,
        videoUrl: `/media/${name}.mp4`,
      })]);

      const range = await fetch(`${calibrator.url}/media/${name}.mp4`, {
        headers: { Range: 'bytes=2-5' },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(Buffer.from(await range.arrayBuffer()).toString()).toBe('2345');

      const saved = await fetch(`${calibrator.url}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story: 'demo',
          target: 'youtube-shorts',
          profile: {
            layoutPreset: 'focus-column',
            framing: { scale: 1.04, focusX: 0.5, focusY: 0.45 },
            captionOptions: { position: 'bottom-left', appearance: 'outline', bottomOffset: 410 },
            protectedRegions: [{ id: 'result', x: 40, y: 120, width: 640, height: 480 }],
          },
        }),
      }).then((response) => response.json());
      expect(saved).toMatchObject({ ok: true, profileHash: expect.any(String) });

      const updated = await fetch(`${calibrator.url}/api/state`).then((response) => response.json());
      expect(updated.targets[0]).toMatchObject({
        status: 'needs-fix',
        hasProfile: true,
        verified: false,
        profileHash: saved.profileHash,
      });
      expect(readProfile(cwd).layoutPreset).toBe('focus-column');
      const savedManifest = JSON.parse(fs.readFileSync(
        path.join(cwd, 'store-assets', 'take-a-repo-manifest.json'),
        'utf8',
      ));
      expect(savedManifest.handoff.approval).toMatchObject({
        status: 'not-ready',
        userActionRequired: false,
        publishable: false,
      });

      const calibrationPath = path.join(cwd, 'take-a-repo.calibration.json');
      const calibration = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
      calibration.profiles.demo['youtube-shorts'].verification = {
        profileHash: saved.profileHash,
        status: 'publish-ready',
        verifiedAt: '2026-07-10T00:00:00.000Z',
      };
      writeJson(calibrationPath, calibration);

      const awaiting = await fetch(`${calibrator.url}/api/state`).then((response) => response.json());
      expect(awaiting.targets[0]).toMatchObject({
        status: 'awaiting-approval',
        machineStatus: 'publish-ready',
        reviewable: true,
        publishable: false,
        review: { status: 'awaiting-approval' },
      });

      const approved = await fetch(`${calibrator.url}/api/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story: 'demo',
          target: 'youtube-shorts',
          status: 'approved',
          assetDigest: DIGEST,
          profileHash: saved.profileHash,
        }),
      }).then((response) => response.json());
      expect(approved).toMatchObject({ ok: true, approvalStatus: 'approved', review: { status: 'approved' } });
      const approvedState = await fetch(`${calibrator.url}/api/state`).then((response) => response.json());
      expect(approvedState.targets[0]).toMatchObject({ status: 'approved', publishable: true });

      const requested = await fetch(`${calibrator.url}/api/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story: 'demo',
          target: 'youtube-shorts',
          status: 'changes-requested',
          assetDigest: DIGEST,
          profileHash: saved.profileHash,
          note: 'Move the result higher.',
        }),
      }).then((response) => response.json());
      expect(requested).toMatchObject({
        ok: true,
        approvalStatus: 'changes-requested',
        review: { status: 'changes-requested', decision: { note: 'Move the result higher.' } },
      });

      await fetch(`${calibrator.url}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story: 'demo',
          target: 'youtube-shorts',
          profile: {
            ...readProfile(cwd),
            captionOptions: { position: 'bottom-left', appearance: 'outline', bottomOffset: 420 },
            verification: undefined,
          },
        }),
      });
      const stale = await fetch(`${calibrator.url}/api/state`).then((response) => response.json());
      expect(stale.targets[0]).toMatchObject({
        status: 'needs-fix',
        reviewable: false,
        review: { status: 'not-ready', stale: true },
      });

      const manifestPath = path.join(cwd, 'store-assets', 'take-a-repo-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.handoff.automation.targets[0].status = 'needs-fix';
      writeJson(manifestPath, manifest);

      const failedRecapture = await fetch(`${calibrator.url}/api/state`).then((response) => response.json());
      expect(failedRecapture.targets[0]).toMatchObject({ status: 'needs-fix', verified: false });
    } finally {
      await calibrator.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function readProfile(cwd) {
  const document = JSON.parse(fs.readFileSync(path.join(cwd, 'take-a-repo.calibration.json'), 'utf8'));
  return document.profiles.demo['youtube-shorts'];
}
