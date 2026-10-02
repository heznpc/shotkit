const http = require('http');
const path = require('path');
const { execFile, spawn } = require('child_process');

const { loadCalibration } = require('./calibration');
const { loadApproval } = require('./approval');
const {
  resolveCampaignRecipes,
} = require('./campaign');
const {
  createCampaignRunController,
  createCampaignStateReader,
} = require('./campaign-dashboard');
const {
  hasCalibration,
} = require('./calibration-verification');
const { safeCampaignStaticPath, safeStaticPath } = require('./calibrator-http');
const { createCalibratorRequestHandler } = require('./calibrator-routes');
const {
  createStateReader,
  profileFor,
  syncApprovalManifest,
} = require('./calibrator-state');

function recaptureCliArgs({ cwd, configPath, story, target, targets, attempt, noBuild = false }) {
  const cliPath = path.join(__dirname, '..', 'bin', 'take-a-repo.js');
  const targetList = targets || [target];
  const args = [cliPath, cwd, '--json', '--scene', story, '--target', targetList.join(','), '--mp4'];
  if (noBuild) args.push('--no-build');
  args.push('--attempt', String(attempt));
  const resolvedConfigPath = path.resolve(cwd, configPath);
  if (resolvedConfigPath !== path.join(path.resolve(cwd), 'take-a-repo.config.js')) {
    args.push('--config', path.relative(cwd, resolvedConfigPath));
  }
  return args;
}

function runRecapture(options) {
  const { cwd } = options;
  const args = recaptureCliArgs(options);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd,
      env: { ...process.env, TAKE_A_REPO_HEADED: '0' },
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      let payload = null;
      try {
        payload = JSON.parse(String(stdout).trim());
      } catch (_parseError) {
        /* handled below */
      }
      const qaFailure = error?.code === 1 && !error.killed && !error.signal && payload?.ok === false
        && ['needs-fix', 'blocked'].includes(payload.machineStatus)
        && typeof payload.manifest === 'string' && Array.isArray(payload.produced);
      if (!payload || payload.error || error && !qaFailure) {
        reject(new Error(payload && payload.error ? payload.error : String(stderr || error || 'recapture failed').trim()));
        return;
      }
      resolve(payload);
    });
  });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
}

async function startCalibrator({
  cwd,
  config,
  configPath,
  port = 0,
  open = true,
  view = 'calibrator',
  captureTarget = runRecapture,
}) {
  const calibrationEnabled = hasCalibration(config);
  if (view === 'calibrator' && !calibrationEnabled) {
    throw new Error('take-a-repo: calibrator requires config.calibration = { from, layouts? }');
  }
  if (!['calibrator', 'campaign'].includes(view)) {
    throw new Error('take-a-repo: dashboard view must be calibrator or campaign');
  }
  const state = createStateReader({ cwd, config });
  let recapturing = false;
  const outDir = path.resolve(cwd, config.outDir || 'store-assets');
  const calibrationDocument = () => (calibrationEnabled ? loadCalibration(config, cwd).document : null);
  const recipes = resolveCampaignRecipes(config);
  const campaignRuns = createCampaignRunController({
    cwd,
    config,
    configPath,
    outDir,
    recipes,
    runner: captureTarget,
    onRunningChange(value) { recapturing = value; },
  });
  const campaignState = createCampaignStateReader({
    cwd,
    config,
    outDir,
    state,
    recipes,
    getRun: campaignRuns.snapshot,
  });

  syncApprovalManifest(outDir, loadApproval(outDir).document, calibrationDocument());
  const handler = createCalibratorRequestHandler({
    cwd,
    config,
    configPath,
    outDir,
    calibrationEnabled,
    state,
    campaignState,
    campaignRuns,
    recipes,
    captureTarget,
    isRecapturing: () => recapturing,
    setRecapturing(value) { recapturing = value; },
    calibrationDocument,
    syncApprovalManifest,
    profileFor,
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const campaignUrl = `${url}/campaign/`;
  if (open) openBrowser(view === 'campaign' ? campaignUrl : url);
  return {
    server,
    url,
    campaignUrl,
    calibratorUrl: url,
    close: async () => {
      await campaignRuns.wait();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = {
  createCampaignStateReader,
  createStateReader,
  recaptureCliArgs,
  runRecapture,
  safeCampaignStaticPath,
  safeStaticPath,
  startCalibrator,
};
