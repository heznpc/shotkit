const fs = require('fs');
const path = require('path');
const os = require('os');
jest.mock('../src/launch', () => ({ launchBrowser: jest.fn(async () => ({ context: {} })), closeContext: jest.fn(async () => {}) }));
jest.mock('../src/capture-demo', () => ({ captureDemo: jest.fn(), DemoPostProcessError: class extends Error {} }));
const { captureDemo } = require('../src/capture-demo');
const { capture } = require('../src/capture');

let cwd;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-qa-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); jest.clearAllMocks(); });

test.each([
  ['caption-overflow', 'needs-fix', 1],
  ['caption-not-observed', 'needs-fix', 1],
  ['caption-font-not-embedded', 'not-requested', 0],
])('plain clips preserve %s warnings and the established preview font exception', async (code, machineStatus, exitCode) => {
  captureDemo.mockResolvedValue({ captionMetricReport: {}, runtimeCaptionWarnings: [{ code, message: 'fixture warning', fix: 'fixture repair' }] });
  const result = await capture({ handoff: false, outDir: 'assets', demos: [{ name: 'demo', lint: false, run: async () => {} }] }, { cwd, log: () => {} });
  expect(result).toMatchObject({ machineStatus, exitCode, captionWarnings: [{ demo: 'demo', code }] });
});
