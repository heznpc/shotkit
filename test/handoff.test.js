const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HANDOFF_KINDS,
  HANDOFF_SCHEMA_IDS,
  HANDOFF_VERSION,
  assetRecord,
  buildHandoffDocs,
  demoStoryboard,
  writeHandoffDocs,
} = require('../src/handoff');

function tmpProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-handoff-'));
  const outDir = path.join(cwd, 'store-assets');
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo-ext', version: '1.0.0', private: true }));
  return { cwd, outDir };
}

describe('handoff contract', () => {
  test('assetRecord stores repo-relative and outDir-relative paths', () => {
    const { cwd, outDir } = tmpProject();
    const filePath = path.join(outDir, 'demo.mp4');
    expect(assetRecord({
      cwd,
      outDir,
      filePath,
      name: 'demo',
      type: 'video',
      role: 'sns-demo-mp4',
    })).toMatchObject({
      id: 'sns-demo-mp4:demo',
      name: 'demo',
      type: 'video',
      role: 'sns-demo-mp4',
      format: 'mp4',
      path: 'store-assets/demo.mp4',
      outPath: 'demo.mp4',
    });
  });

  test('demoStoryboard converts captions into portable beats', () => {
    expect(demoStoryboard({
      name: 'demo-translate',
      preset: 'sns-video',
      mp4: { crf: 18 },
      trim: { duration: '00:30' },
      nextTool: 'screen-studio',
      captions: [
        { at: 0.5, text: 'Translate in place' },
        { at: '00:08', text: 'Restore original text' },
      ],
    }, { width: 1280, height: 720 })).toMatchObject({
      name: 'demo-translate',
      audience: 'sns',
      recommendedNextTool: 'screen-studio',
      viewport: { width: 1280, height: 720 },
      captionStyle: { mode: 'static', appearance: 'panel', position: 'bottom-left' },
      beats: [
        { at: 0.5, atMs: 500, text: 'Translate in place' },
        { at: 8, atMs: 8000, text: 'Restore original text' },
      ],
    });
  });

  test('buildHandoffDocs links manifest, captions, storyboards, and assets', () => {
    const { cwd, outDir } = tmpProject();
    const assets = [
      assetRecord({
        cwd,
        outDir,
        filePath: path.join(outDir, 'demo.mp4'),
        name: 'demo',
        type: 'video',
        role: 'sns-demo-mp4',
      }),
    ];
    const docs = buildHandoffDocs({
      cwd,
      outDir,
      config: { disclaimer: 'Demo only' },
      assets,
      demoConfigs: [{ name: 'demo', run: async () => {}, captions: [{ at: 1, text: 'Restore anytime' }] }],
      demoViewports: { demo: { width: 1280, height: 720 } },
      demoWarnings: {
        demo: [{
          code: 'demo-warning',
          severity: 'warning',
          message: 'demo warning',
          fix: 'fix the demo',
        }],
      },
      demoCaptionReports: {
        demo: {
          expectedFrames: [{ atMs: 1000, text: 'Restore anytime' }],
          samples: [{
            fontConfigured: true,
            fontLoaded: true,
            fontLoadMs: 7,
            fitStatus: 'fit',
            fontSize: 38,
            lineCount: 1,
            lineBalance: 1,
          }],
          typography: {
            enabled: true,
            deterministic: true,
            locale: 'en-US',
            direction: 'ltr',
            fontFiles: ['fonts/NotoSans.ttf'],
            fontOptimization: [{ family: 'Noto Sans', sourceBytes: 1000, embeddedBytes: 300 }],
            missingGlyphs: [],
          },
        },
      },
      flags: { freeze: true, liveGt: false },
    });

    expect(docs.manifest).toMatchObject({
      $schema: HANDOFF_SCHEMA_IDS.manifest,
      kind: HANDOFF_KINDS.manifest,
      version: HANDOFF_VERSION,
      tool: 'take-a-repo',
      project: { name: 'demo-ext', version: '1.0.0', private: true },
      handoff: {
        contractVersion: HANDOFF_VERSION,
        entrypoint: 'take-a-repo-manifest.json',
        schemaFiles: {
          manifest: 'schemas/take-a-repo-manifest.schema.json',
          storyboard: 'schemas/storyboard.schema.json',
          captions: 'schemas/captions.schema.json',
          approval: 'schemas/approval.schema.json',
        },
        storyboards: 'storyboard.json',
        captions: 'captions.json',
        review: {
          status: 'needs-review',
          warningCount: 1,
        },
      },
    });
    expect(docs.manifest.handoff.adapterHints.map((item) => item.id)).toContain('screen-studio');
    expect(docs.storyboard.kind).toBe(HANDOFF_KINDS.storyboard);
    expect(docs.captions.kind).toBe(HANDOFF_KINDS.captions);
    expect(docs.captions.demos[0].style).toEqual({
      mode: 'static',
      appearance: 'panel',
      position: 'bottom-left',
    });
    expect(docs.captions.demos[0].timeline).toEqual([{
      at: 1,
      atMs: 1000,
      text: 'Restore anytime',
      sourceText: 'Restore anytime',
      words: ['Restore', 'anytime'],
      activeWordIndex: null,
      condensed: false,
    }]);
    expect(docs.captions.demos[0].qa).toEqual({
      scheduledFrameCount: 1,
      measuredFrameCount: 1,
      typography: expect.objectContaining({ deterministic: true, locale: 'en-US' }),
      rendering: {
        fontLoaded: true,
        maxFontLoadMs: 7,
        fitStatuses: ['fit'],
        resolvedFontSize: { min: 38, max: 38 },
        maxLineCount: 1,
        minLineBalance: 1,
      },
    });
    expect(docs.storyboard.demos[0].beats[0].text).toBe('Restore anytime');
    expect(docs.captions.demos[0].captions[0].atMs).toBe(1000);
    expect(docs.storyboard.storyboardLint).toEqual([{
      name: 'demo',
      ok: false,
      warnings: [{
        code: 'demo-warning',
        severity: 'warning',
        message: 'demo warning',
        fix: 'fix the demo',
      }],
    }]);
  });

  test('writeHandoffDocs writes all contract files and includes them in the manifest assets', () => {
    const { cwd, outDir } = tmpProject();
    const paths = writeHandoffDocs({
      cwd,
      outDir,
      config: {},
      assets: [],
      demoConfigs: [],
      demoViewports: {},
      demoWarnings: {},
      flags: {},
    });

    expect(paths.map((p) => path.relative(outDir, p))).toEqual([
      'storyboard.json',
      'captions.json',
      'take-a-repo-manifest.json',
      'schemas/take-a-repo-manifest.schema.json',
      'schemas/storyboard.schema.json',
      'schemas/captions.schema.json',
      'schemas/approval.schema.json',
    ]);
    for (const filePath of paths) expect(fs.existsSync(filePath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.assets.map((asset) => asset.role)).toEqual([
      'storyboard-contract',
      'captions-contract',
      'handoff-manifest',
      'handoff-schema',
      'handoff-schema',
      'handoff-schema',
      'handoff-schema',
    ]);
    expect(manifest.handoff.summary).toEqual({
      assetCount: 7,
      demoCount: 0,
      readyAdapterCount: 0,
      publishReadyTargetCount: 0,
      approvedTargetCount: 0,
    });
    const storyboard = manifest.assets.find((asset) => asset.role === 'storyboard-contract');
    expect(storyboard.bytes).toBeGreaterThan(0);
    expect(storyboard.integrity).toMatchObject({ algorithm: 'sha256' });
    expect(storyboard.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('reports deterministic fonts loaded only when every measured frame kept the font setup', () => {
    const { cwd, outDir } = tmpProject();
    const docs = buildHandoffDocs({
      cwd,
      outDir,
      config: {},
      assets: [],
      demoConfigs: [{ name: 'demo', run: async () => {} }],
      demoViewports: { demo: { width: 720, height: 1280 } },
      demoWarnings: { demo: [] },
      demoCaptionReports: {
        demo: {
          expectedFrames: [{ atMs: 0, text: 'A' }, { atMs: 200, text: 'B' }],
          samples: [
            { fontConfigured: true, fontLoaded: true, fitStatus: 'fit' },
            { fontConfigured: false, fontLoaded: null, fitStatus: 'not-requested' },
          ],
          typography: { enabled: true, deterministic: true, locale: 'en-US', direction: 'ltr' },
        },
      },
      flags: {},
    });

    expect(docs.captions.demos[0].qa.rendering).toMatchObject({
      fontLoaded: false,
      fitStatuses: ['fit', 'not-requested'],
    });
  });

  test('partial runs prune missing files and recompute adapter readiness from preserved assets', () => {
    const { cwd, outDir } = tmpProject();
    const mp4Path = path.join(outDir, 'demo.mp4');
    fs.writeFileSync(mp4Path, 'video-proof');
    const mp4 = assetRecord({
      cwd,
      outDir,
      filePath: mp4Path,
      name: 'demo',
      type: 'video',
      role: 'sns-demo-mp4',
      source: { kind: 'demo', name: 'demo' },
    });

    const write = (partial) => writeHandoffDocs({
      cwd,
      outDir,
      config: {},
      assets: partial ? [] : [mp4],
      demoConfigs: [],
      demoViewports: {},
      demoWarnings: {},
      flags: {},
      partial,
    });

    write(false);
    const firstManifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    const originalRunId = firstManifest.assets.find((asset) => asset.id === mp4.id).runId;
    write(true);
    let manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.assets.some((asset) => asset.id === mp4.id)).toBe(true);
    expect(manifest.assets.find((asset) => asset.id === mp4.id)).toMatchObject({
      runId: originalRunId,
      state: 'retained',
    });
    expect(manifest.run.id).not.toBe(originalRunId);
    expect(manifest.handoff.adapterHints.find((hint) => hint.id === 'screen-studio').readiness).toBe('ready');

    fs.writeFileSync(mp4Path, 'tampered-video-proof');
    write(true);
    manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.assets.find((asset) => asset.id === mp4.id)).toMatchObject({
      state: 'modified',
      observed: { integrity: { algorithm: 'sha256' } },
    });
    expect(manifest.handoff.review).toMatchObject({
      status: 'incomplete',
      incomplete: [{ code: 'asset-integrity-mismatch', asset: mp4.id }],
    });
    expect(manifest.handoff.adapterHints.find((hint) => hint.id === 'screen-studio').readiness).toBe('needs-assets');

    fs.rmSync(mp4Path);
    write(true);
    manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.assets.some((asset) => asset.id === mp4.id)).toBe(false);
    expect(manifest.handoff.adapterHints.find((hint) => hint.id === 'screen-studio').readiness).toBe('needs-assets');
  });

  test('a refreshed logical output replaces all retained formats from that source', () => {
    const { cwd, outDir } = tmpProject();
    const mp4Path = path.join(outDir, 'demo.mp4');
    const webmPath = path.join(outDir, 'demo.webm');
    fs.writeFileSync(mp4Path, 'old-mp4');
    const record = (filePath, role) => assetRecord({
      cwd,
      outDir,
      filePath,
      name: 'demo',
      type: 'video',
      role,
      source: { kind: 'demo', name: 'demo' },
    });
    const write = (assets, partial) => writeHandoffDocs({
      cwd,
      outDir,
      config: {},
      assets,
      demoConfigs: [],
      demoViewports: {},
      demoWarnings: {},
      flags: {},
      partial,
    });

    write([record(mp4Path, 'sns-demo-mp4')], false);
    fs.writeFileSync(webmPath, 'fresh-webm');
    write([record(webmPath, 'source-demo-webm')], true);

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.assets.some((asset) => asset.outPath === 'demo.mp4')).toBe(false);
    expect(manifest.assets.find((asset) => asset.outPath === 'demo.webm')).toMatchObject({ state: 'produced' });
  });

  test('does not merge a prior pack that fails its published schema', () => {
    const { cwd, outDir } = tmpProject();
    const mp4Path = path.join(outDir, 'demo.mp4');
    fs.writeFileSync(mp4Path, 'prior-video');
    const mp4 = assetRecord({
      cwd,
      outDir,
      filePath: mp4Path,
      name: 'demo',
      type: 'video',
      role: 'sns-demo-mp4',
      source: { kind: 'demo', name: 'demo' },
    });
    const args = {
      cwd,
      outDir,
      config: {},
      demoConfigs: [],
      demoViewports: {},
      demoWarnings: {},
      flags: {},
    };
    writeHandoffDocs({ ...args, assets: [mp4] });
    const storyboardPath = path.join(outDir, 'storyboard.json');
    const storyboard = JSON.parse(fs.readFileSync(storyboardPath, 'utf8'));
    storyboard.purpose = 'not-a-take-a-repo-purpose';
    fs.writeFileSync(storyboardPath, JSON.stringify(storyboard));

    writeHandoffDocs({ ...args, assets: [], partial: true });

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.assets.some((asset) => asset.id === mp4.id)).toBe(false);
  });

  test('rejects duplicate asset ids or output paths before publishing the manifest', () => {
    const { cwd, outDir } = tmpProject();
    const filePath = path.join(outDir, 'same.png');
    fs.writeFileSync(filePath, 'image');
    const shared = {
      cwd,
      outDir,
      filePath,
      name: 'same',
      type: 'image',
      source: { kind: 'scene', name: 'same' },
    };
    expect(() => writeHandoffDocs({
      cwd,
      outDir,
      config: {},
      assets: [
        assetRecord({ ...shared, role: 'store-screenshot' }),
        assetRecord({ ...shared, role: 'promo-tile' }),
      ],
      demoConfigs: [],
      demoViewports: {},
      demoWarnings: {},
      flags: {},
    })).toThrow(/duplicate asset outPath/);
  });

  test('a fresh no-video run reports configured demos as incomplete', async () => {
    const { cwd } = tmpProject();
    const { capture } = require('../src/capture');
    const result = await capture({
      demo: {
        name: 'demo-launch',
        captions: [{ at: 1, text: 'Show the result' }],
        run: async () => {},
      },
    }, {
      cwd,
      noBuild: true,
      noVideo: true,
      log: () => {},
    });

    const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
    expect(manifest.run).toMatchObject({
      mode: 'partial',
      configuredDemos: ['demo-launch'],
      selectedDemos: ['demo-launch'],
      capturedDemos: [],
      skippedDemos: ['demo-launch'],
    });
    expect(manifest.handoff.review).toMatchObject({
      status: 'incomplete',
      incomplete: [{ code: 'demo-skipped', demo: 'demo-launch', reason: 'video-disabled' }],
    });
    const supademo = manifest.handoff.adapterHints.find((hint) => hint.id === 'supademo');
    expect(supademo).toMatchObject({ readiness: 'needs-assets', missingRoles: ['storyboard-content'] });
  });

  test('rejects forged QA metadata on invalid final media without manual adapters', () => {
    const { cwd, outDir } = tmpProject();
    const { normalizeDemoConfigs } = require('../src/demo');
    const [demo] = normalizeDemoConfigs({
      demo: {
        name: 'skillbridge',
        targets: ['x'],
        captions: [
          { at: 0.5, text: 'Translate the lesson' },
          { at: 18, text: 'Restore the original anytime' },
        ],
        run: async () => {},
      },
    });
    const mp4Path = path.join(outDir, `${demo.name}.mp4`);
    const thumbnailPath = path.join(outDir, `${demo.name}-thumbnail.png`);
    fs.writeFileSync(mp4Path, 'mp4');
    fs.writeFileSync(thumbnailPath, 'png');
    const source = { kind: 'demo', name: demo.name, story: demo.story, target: demo.target };
    const assets = [
      assetRecord({
        cwd,
        outDir,
        filePath: mp4Path,
        name: demo.name,
        type: 'video',
        role: 'sns-demo-mp4',
        target: 'x',
        channel: 'x',
        media: {
          ok: true,
          codec: 'h264',
          pixelFormat: 'yuv420p',
          width: 1280,
          height: 720,
          durationSeconds: 30,
        },
        source,
      }),
      assetRecord({
        cwd,
        outDir,
        filePath: thumbnailPath,
        name: `${demo.name}-thumbnail`,
        type: 'image',
        role: 'thumbnail',
        target: 'x',
        channel: 'x',
        visual: { ok: true, width: 1280, height: 720, nonBlank: true, colorBuckets: 32 },
        source,
      }),
    ];

    writeHandoffDocs({
      cwd,
      outDir,
      config: {},
      assets,
      demoConfigs: [demo],
      demoViewports: { [demo.name]: { width: 1280, height: 720 } },
      demoWarnings: { [demo.name]: [] },
      flags: {},
      run: {
        configuredDemos: [demo.name],
        configuredTargets: ['x'],
        configuredTargetDemos: [{ name: demo.name, story: demo.story, target: 'x' }],
        selectedDemos: [demo.name],
        capturedDemos: [demo.name],
      },
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'take-a-repo-manifest.json'), 'utf8'));
    expect(manifest.handoff.automation).toMatchObject({
      policy: 'exception-only',
      status: 'needs-fix',
      manualFallback: false,
      userActionRequired: false,
      targets: [{ target: 'x', demo: demo.name, status: 'needs-fix' }],
      actions: expect.arrayContaining([expect.objectContaining({ code: 'media-probe-failed' }), expect.objectContaining({ code: 'thumbnail-qa-failed' })]),
    });
    expect(manifest.handoff.adapterHints).toEqual([]);
    expect(manifest.handoff.summary.publishReadyTargetCount).toBe(0);
    expect(manifest.handoff.approval).toMatchObject({
      status: 'not-ready',
      userActionRequired: false,
      publishable: false,
      targets: [{ target: 'x', status: 'not-ready' }],
    });
    expect(manifest.handoff.summary.approvedTargetCount).toBe(0);
  });
});
