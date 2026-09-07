const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { readEvidence, measureAsset, digest } = require('./evidence-contract');
const { safeAssetPath, writeJson } = require('./handoff-files');

function provenance(cwd, config) {
  const git = (args) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 ** 2 }).trim(); }
    catch (_error) { return null; }
  };
  return {
    revision: git(['rev-parse', 'HEAD']),
    dirty: !!git(['status', '--porcelain']),
    trackedDiffDigest: digest(git(['diff', 'HEAD', '--binary']) || ''),
    // Config functions are committed executable intent, not JSON data.
    configDigest: digest(JSON.stringify(config, (_key, value) => typeof value === 'function' ? value.toString() : value)),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

function execute(argv, { cwd, outDir, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: { ...process.env, TAKE_A_REPO_OUTPUT_DIR: outDir },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let output = '';
    let failure = null;
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (_error) { /* already exited */ }
    };
    const timer = setTimeout(() => { failure = `producer timed out after ${timeoutMs}ms`; kill(); }, timeoutMs);
    const append = (chunk) => {
      if (output.length + chunk.length > 1024 * 1024) {
        failure = 'producer output exceeded 1 MiB'; kill(); return;
      }
      output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => { failure = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // A successful parent must not leave capture/server grandchildren alive.
      kill();
      try { fs.writeFileSync(path.join(outDir, 'execution.log'), output || `(exit ${code}, signal ${signal || 'none'})\n`); }
      catch (error) { failure = `could not persist execution log: ${error.message}`; }
      resolve({ exitCode: code, signal, ...(failure ? { error: failure } : {}) });
    });
  });
}

async function browserEvidence(producer, cwd, outDir, log) {
  const result = await require('./capture').capture({ ...producer.capture, outDir, handoff: true }, { cwd, json: true, log });
  const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
  const mediaTypes = { image: 'image/png', video: 'video/mp4', text: 'text/markdown' };
  const assets = manifest.assets.filter((a) => mediaTypes[a.type]).map((asset, index) => ({
    id: `asset-${index}`, path: asset.outPath,
    mediaType: asset.outPath.endsWith('.webm') ? 'video/webm' : mediaTypes[asset.type],
    role: asset.type === 'video' ? 'recording' : asset.type === 'image' ? 'screenshot' : 'artifact',
    description: asset.name || asset.outPath,
  }));
  const checks = assets.length ? [{
    id: 'capture', status: ['needs-fix', 'blocked'].includes(result.machineStatus) ? 'fail' : 'pass',
    summary: 'Configured browser scenes executed; feature assertions must be in the scene hooks. Navigation alone does not prove a feature.',
    assets: assets.map((a) => a.id),
  }] : [];
  writeJson(path.join(outDir, 'evidence.json'), { version: 1, assets, checks });
}

async function runProducer(producer, { cwd, runDir, log }) {
  const outDir = path.join(runDir, 'raw', producer.id);
  fs.mkdirSync(outDir, { recursive: true });
  const record = { id: producer.id, kind: producer.kind, mode: producer.import ? 'imported' : 'executed', startedAt: new Date().toISOString(), assets: [], checks: [] };
  try {
    if (producer.command) {
      record.command = producer.command;
      record.execution = await execute(producer.command, { cwd, outDir, timeoutMs: producer.timeoutMs });
      if (record.execution.error || record.execution.exitCode !== 0) throw new Error(record.execution.error || `producer exited ${record.execution.exitCode}`);
    } else if (producer.capture) {
      await browserEvidence(producer, cwd, outDir, log);
    }
    const inputFile = producer.import
      ? safeAssetPath(cwd, { outPath: producer.import }) : path.join(outDir, 'evidence.json');
    if (!inputFile) throw new Error('import must be inside the consumer checkout');
    const input = readEvidence(inputFile);
    for (const asset of input.assets) {
      let measured = measureAsset(path.dirname(inputFile), asset);
      const source = safeAssetPath(path.dirname(inputFile), { outPath: asset.path });
      // Snapshot imports; never serve or approve mutable originals in-place.
      const target = producer.import ? path.join(outDir, `${asset.id}${path.extname(asset.path)}`) : source;
      if (producer.import) {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        measured = measureAsset(outDir, { ...asset, path: path.basename(target) });
      }
      record.assets.push({ ...measured, path: path.relative(runDir, target), producer: producer.id });
    }
    record.checks = input.checks.map((check) => ({
      ...check, status: producer.import ? 'unverified' : check.status,
      verification: producer.import ? 'imported-not-reexecuted' : 'producer-asserted',
    }));
    record.status = record.checks.some((c) => c.status === 'fail') ? 'failed' : 'collected';
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    log(`${producer.id}: ${error.message}`);
  }
  record.finishedAt = new Date().toISOString();
  return record;
}

module.exports = { provenance, runProducer, execute };
