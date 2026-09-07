const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateEvidenceConfig, digest } = require('./evidence-contract');
const { provenance, runProducer, execute } = require('./evidence-producer');
const { renderDeliverable } = require('./evidence-render');
const { withRunSession } = require('./run-session');
const { writeJson, sha256File, readJsonIfExists } = require('./handoff-files');

function resolveClaims(spec, producers) {
  return spec.claims.map((claim) => {
    const statuses = claim.checks.map((ref) => {
      const [producerId, checkId] = ref.split(':');
      const producer = producers.find((p) => p.id === producerId);
      if (producer?.status === 'failed') return 'fail';
      return producer?.checks.find((c) => c.id === checkId)?.status || 'unverified';
    });
    return { ...claim, status: statuses.includes('fail') ? 'fail' : statuses.every((s) => s === 'pass') ? 'verified' : 'unverified' };
  });
}

async function captureEvidence(config, opts = {}) {
  const spec = validateEvidenceConfig(config);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const outDir = path.resolve(cwd, config.outDir || 'product-evidence');
  const log = opts.log || ((message) => console.error(`[take-a-repo] ${message}`));
  // Raw evidence and decisions are never merged across different executions.
  // A scoped run explicitly narrows the *new candidate*, not an old whole-pack
  // approval. Full completion requires a full run and is visible in scope.
  const scenes = opts.scenes || [];
  for (const name of scenes) if (!spec.producers.some((p) => p.id === name)) throw new Error(`unknown evidence producer: ${name}`);
  if (opts.targets?.length || opts.noVideo || opts.mp4 || opts.calibrate || opts.campaign) {
    throw new Error('evidence configs use declared deliverables and `review`, not browser target/no-video/mp4/calibrator flags');
  }
  return withRunSession(outDir, async () => {
    const id = crypto.randomUUID();
    const runDir = path.join(outDir, 'runs', id);
    fs.mkdirSync(runDir, { recursive: true });
    const report = {
      version: 1, kind: 'take-a-repo.evidence-run', id, startedAt: new Date().toISOString(),
      scope: { full: scenes.length === 0, producers: scenes.length ? scenes : spec.producers.map((p) => p.id), deliverables: spec.deliverables.map((d) => d.id) },
      source: provenance(cwd, config), producers: [], claims: [], deliverables: [], files: [], actions: [],
      machineStatus: 'needs-fix',
    };
    const pointer = path.join(outDir, 'take-a-repo-evidence.json');
    const previous = readJsonIfExists(pointer);
    if (previous?.id) report.previousRunId = previous.id;
    writeJson(pointer, { version: 1, id, state: 'running', run: `runs/${id}/run.json` });
    try {
      if (config.build && !opts.noBuild) {
        // Same committed-command trust boundary as legacy config.build.
        report.build = await execute(process.platform === 'win32' ? ['cmd', '/c', config.build] : ['/bin/sh', '-c', config.build], { cwd, outDir: runDir });
        if (report.build.exitCode !== 0 || report.build.error) throw new Error(`build failed: ${report.build.error || report.build.exitCode}`);
      }
      for (const producer of spec.producers) {
        if (scenes.length && !scenes.includes(producer.id)) continue;
        log(`collect ${producer.kind}: ${producer.id}`);
        const result = await runProducer(producer, { cwd, runDir, log });
        report.producers.push(result);
        if (result.status === 'failed') report.actions.push({ code: 'producer-failed', owner: 'agent', producer: producer.id, fix: result.error || 'fix the failing producer checks', retryScenes: [producer.id] });
      }
      report.claims = resolveClaims(spec, report.producers);
      for (const claim of report.claims.filter((c) => c.status !== 'verified')) {
        report.actions.push({ code: 'claim-not-verified', owner: 'agent', claim: claim.id, fix: 'execute the referenced checks against the product; do not mark imports as passed', retryScenes: [...new Set(claim.checks.map((ref) => ref.split(':')[0]))] });
      }
      for (const delivery of spec.deliverables) {
        try {
          const files = renderDeliverable(delivery, report, runDir);
          report.deliverables.push({ ...delivery, status: 'rendered', files: files.map((f) => f.path) });
          report.files.push(...files);
        } catch (error) {
          report.deliverables.push({ ...delivery, status: 'failed', files: [], error: error.message });
          report.actions.push({ code: 'render-failed', owner: 'agent', deliverable: delivery.id, fix: error.message });
        }
      }
      if (scenes.length) report.actions.push({ code: 'partial-evidence-run', owner: 'agent', fix: 'run the complete config before reviewing the full delivery' });
      report.files.push(...report.producers.flatMap((p) => p.assets));
      report.files = report.files.map((file) => {
        const sha256 = sha256File(path.join(runDir, file.path));
        if (file.sha256 && file.sha256 !== sha256) throw new Error(`asset changed after QA: ${file.path}`);
        return { ...file, sha256, bytes: fs.statSync(path.join(runDir, file.path)).size };
      });
      report.machineStatus = report.actions.length ? 'needs-fix' : 'publish-ready';
    } catch (error) {
      report.actions.push({ code: 'run-failed', owner: 'agent', fix: error.message });
    }
    report.finishedAt = new Date().toISOString();
    report.sourceAfter = provenance(cwd, config);
    const attempt = opts.attempt || 1;
    const maxAttempts = config.automation?.maxAttempts || 3;
    if (report.actions.length && attempt >= maxAttempts) report.machineStatus = 'blocked';
    report.automation = { attempt, maxAttempts, retryScenes: [...new Set(report.actions.flatMap((a) => a.retryScenes || []))], userActionRequired: report.machineStatus === 'blocked' };
    report.assetSetDigest = digest(JSON.stringify(report.files.map((f) => [f.path, f.sha256]).sort((a, b) => a[0].localeCompare(b[0]))));
    const manifest = path.join(runDir, 'run.json');
    writeJson(manifest, report);
    writeJson(pointer, { version: 1, id, state: 'completed', run: `runs/${id}/run.json`, sha256: sha256File(manifest) });
    const status = report.machineStatus === 'publish-ready' ? 'awaiting-approval' : report.machineStatus;
    log(`evidence ${id}: ${status}`);
    return { produced: [manifest, ...report.files.map((f) => path.join(runDir, f.path))], outDir, manifest, status, machineStatus: report.machineStatus, exitCode: report.actions.length ? 1 : 0 };
  });
}

module.exports = { captureEvidence, resolveClaims };
