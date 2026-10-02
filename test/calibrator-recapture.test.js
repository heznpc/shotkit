jest.mock('child_process', () => ({ execFile: jest.fn(), spawn: jest.fn() }));
const { execFile } = require('child_process');
const { runRecapture } = require('../src/calibrator-server');
const options = { cwd: '/tmp/project', configPath: '/tmp/project/take-a-repo.config.js', story: 'demo', target: 'x', attempt: 1 };

afterEach(() => jest.clearAllMocks());

test.each(['needs-fix', 'blocked'])('valid QA failure remains available for profile retry state: %s', async (machineStatus) => {
  const payload = { ok: false, machineStatus, manifest: '/tmp/project/assets/take-a-repo-manifest.json', produced: [] };
  execFile.mockImplementation((_bin, _args, _options, callback) => callback(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify(payload), ''));
  await expect(runRecapture(options)).resolves.toEqual(payload);
});

test('runtime failures and killed runs cannot be accepted as completed QA failures', async () => {
  execFile.mockImplementationOnce((_bin, _args, _options, callback) => callback(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify({ ok: false, error: 'build failed' }), ''));
  await expect(runRecapture(options)).rejects.toThrow('build failed');
  const payload = { ok: false, machineStatus: 'needs-fix', manifest: '/tmp/manifest.json', produced: [] };
  execFile.mockImplementationOnce((_bin, _args, _options, callback) => callback(Object.assign(new Error('timeout'), { code: 1, killed: true }), JSON.stringify(payload), 'timed out'));
  await expect(runRecapture(options)).rejects.toThrow('timed out');
});
