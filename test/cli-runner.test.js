const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli } = require('../src/cli-runner');

function streamBuffer() {
  let value = '';
  return {
    stream: { write: (chunk) => { value += chunk; } },
    read: () => value,
  };
}

function tmpProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cli-runner-'));
  const configPath = path.join(cwd, 'take-a-repo.config.js');
  fs.writeFileSync(configPath, 'module.exports = {};');
  return { cwd, configPath };
}

describe('runCli', () => {
  test('unwraps a default-exported config and preserves evidence failure exit status', async () => {
    const { cwd } = tmpProject();
    const stdout = streamBuffer();
    const config = { evidence: { version: 1 } };
    const capture = jest.fn(async () => ({ produced: [], outDir: cwd, machineStatus: 'needs-fix', status: 'needs-fix', exitCode: 1 }));
    const code = await runCli(['--json'], { processCwd: () => cwd, stdout: stdout.stream }, { capture, loadConfig: () => ({ default: config }) });
    expect(capture).toHaveBeenCalledWith(config, expect.any(Object));
    expect(code).toBe(1);
    expect(JSON.parse(stdout.read())).toMatchObject({ ok: false, machineStatus: 'needs-fix' });
  });
  test('json success writes exactly one parseable stdout object and routes progress to stderr', async () => {
    const { cwd, configPath } = tmpProject();
    const stdout = streamBuffer();
    const stderr = streamBuffer();
    const capture = jest.fn(async (_config, opts) => {
      opts.log('capturing');
      return {
        outDir: path.join(cwd, 'store-assets'),
        manifest: path.join(cwd, 'store-assets', 'take-a-repo-manifest.json'),
        status: 'awaiting-approval',
        machineStatus: 'publish-ready',
        produced: [path.join(cwd, 'store-assets', 'a.png')],
      };
    });

    const code = await runCli(['--json'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      processCwd: () => cwd,
    }, {
      capture,
      loadConfig: jest.fn(() => ({ loadedFrom: configPath })),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: true,
      status: 'awaiting-approval',
      machineStatus: 'publish-ready',
      outDir: path.join(cwd, 'store-assets'),
      manifest: path.join(cwd, 'store-assets', 'take-a-repo-manifest.json'),
      produced: [path.join(cwd, 'store-assets', 'a.png')],
    });
    expect(stderr.read()).toContain('[take-a-repo] capturing');
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ loadedFrom: configPath }), expect.objectContaining({ cwd, json: true }));
  });

  test('json runtime failures write the error payload to stdout', async () => {
    const { cwd } = tmpProject();
    const stdout = streamBuffer();
    const stderr = streamBuffer();

    const code = await runCli(['--json'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      processCwd: () => cwd,
    }, {
      capture: jest.fn(async () => {
        throw new Error('boom');
      }),
      loadConfig: jest.fn(() => ({})),
    });

    expect(code).toBe(1);
    expect(JSON.parse(stdout.read())).toEqual({ ok: false, error: 'boom', code: 1 });
    expect(stderr.read()).toBe('');
  });

  test('starts the calibrator without running capture', async () => {
    const { cwd, configPath } = tmpProject();
    const stdout = streamBuffer();
    const stderr = streamBuffer();
    const capture = jest.fn();
    const startCalibrator = jest.fn(async () => ({ url: 'http://127.0.0.1:4312' }));
    const config = { calibration: { from: 'take-a-repo.calibration.json' } };

    const code = await runCli(['--calibrate', '--port', '4312', '--no-open', '--json'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      processCwd: () => cwd,
    }, {
      capture,
      startCalibrator,
      loadConfig: jest.fn(() => config),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: true,
      status: 'calibrating',
      url: 'http://127.0.0.1:4312',
    });
    expect(startCalibrator).toHaveBeenCalledWith({
      cwd,
      config,
      configPath,
      port: 4312,
      open: false,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  test('starts the campaign dashboard without changing the calibrator entrypoint', async () => {
    const { cwd, configPath } = tmpProject();
    const stdout = streamBuffer();
    const stderr = streamBuffer();
    const capture = jest.fn();
    const startCalibrator = jest.fn(async () => ({
      url: 'http://127.0.0.1:4312',
      campaignUrl: 'http://127.0.0.1:4312/campaign/',
    }));
    const config = { calibration: { from: 'take-a-repo.calibration.json' } };

    const code = await runCli(['--campaign', '--port', '4312', '--no-open', '--json'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      processCwd: () => cwd,
    }, {
      capture,
      startCalibrator,
      loadConfig: jest.fn(() => config),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.read())).toEqual({
      ok: true,
      status: 'campaign-dashboard',
      url: 'http://127.0.0.1:4312/campaign/',
    });
    expect(startCalibrator).toHaveBeenCalledWith({
      cwd,
      config,
      configPath,
      port: 4312,
      open: false,
      view: 'campaign',
    });
    expect(capture).not.toHaveBeenCalled();
  });
});
