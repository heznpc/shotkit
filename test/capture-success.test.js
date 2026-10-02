const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/launch', () => {
  const mockFs = require('fs');
  const events = [];
  let closed = false;
  const page = {
    setViewportSize: jest.fn(async () => {}),
    on: jest.fn(),
    off: jest.fn(),
    evaluate: jest.fn(async () => {}),
    waitForTimeout: jest.fn(async () => {}),
    video: jest.fn(() => {
      events.push('video-handle');
      return {
        saveAs: jest.fn(async (out) => {
          events.push('video-save');
          mockFs.writeFileSync(out, 'webm');
        }),
      };
    }),
    close: jest.fn(async () => {
      events.push('page-close');
      closed = true;
    }),
    isClosed: jest.fn(() => closed),
  };
  return {
    __events: events,
    __reset: () => {
      events.length = 0;
      closed = false;
    },
    launchBrowser: jest.fn(async () => ({
      extensionId: 'test-extension',
      context: {
        addInitScript: jest.fn(async () => {}),
        newPage: jest.fn(async () => page),
      },
    })),
    closeContext: jest.fn(async () => events.push('context-close')),
  };
});

jest.mock('../src/video', () => ({
  ...jest.requireActual('../src/video'),
  postProcessDemo: jest.fn(() => []),
}));

const launch = require('../src/launch');
const { capture } = require('../src/capture');

beforeEach(() => {
  jest.clearAllMocks();
  launch.__reset();
});

test('successful demo capture preserves the recording and cleanup order', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-capture-success-'));
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-extension-'));
  const demoRun = jest.fn(async () => {});

  const result = await capture({
    outDir: 'store-assets',
    prepareExtension: async () => ({
      dir: extensionDir,
      cleanup: async () => launch.__events.push('extension-cleanup'),
    }),
    setup: async () => ({
      env: { baseUrl: 'http://127.0.0.1:4321' },
      teardown: async () => launch.__events.push('setup-teardown'),
    }),
    demos: [{ name: 'demo', run: demoRun }],
  }, {
    cwd,
    noBuild: true,
    log: () => {},
  });

  expect(demoRun).toHaveBeenCalledTimes(1);
  expect(launch.__events).toEqual([
    'video-handle',
    'page-close',
    'video-save',
    'context-close',
    'setup-teardown',
    'extension-cleanup',
  ]);
  expect(result.produced).toContain(path.join(cwd, 'store-assets', 'demo.webm'));
  const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
  expect(manifest.run).toMatchObject({
    mode: 'full',
    selectedDemos: ['demo'],
    capturedDemos: ['demo'],
    skippedDemos: [],
  });
  expect(manifest.assets).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'source-demo-webm', state: 'produced', source: expect.objectContaining({ captionState: 'none' }) }),
  ]));
});

test('browser target QA failure returns a failing exit code even when recording succeeds', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-capture-qa-'));
  try {
    // postProcessDemo above deliberately produces no target MP4. The recorded
    // webm alone must not turn this failed target into a successful CLI result.
    const result = await capture({ outDir: 'assets', demos: [{ name: 'demo', targets: ['x'], run: async () => {} }] }, { cwd, log: () => {} });
    expect(result).toMatchObject({ machineStatus: 'needs-fix', exitCode: 1 });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
