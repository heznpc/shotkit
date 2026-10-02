const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateEvidenceConfig, digest } = require('./evidence-contract');
const { fingerprintInputs } = require('./evidence-inputs');
const { provenance, runProducer, execute } = require('./evidence-producer');
const { validateEditorial, renderProductionDeliverable } = require('./production-render');
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
  let spec = validateEvidenceConfig(config);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const outDir = path.resolve(cwd, config.outDir || 'product-evidence');
  const log = opts.log || ((message) => console.error(`[take-a-repo] ${message}`));
  // Each candidate owns a complete file set and a separate approval. Production
  // may copy validated cached artifacts while retaining their original capture
  // provenance; scoped diagnostic runs never acquire a whole-pack approval.
  const scenes = opts.scenes || [];
  for (const name of scenes) if (!spec.producers.some((p) => p.id === name)) throw new Error(`unknown evidence producer: ${name}`);
  if (opts.targets?.length || opts.noVideo || opts.mp4 || opts.calibrate || opts.campaign) {
    throw new Error('evidence configs use declared deliverables and `review`, not browser target/no-video/mp4/calibrator flags');
  }
  return withRunSession(outDir, async () => {
    let savedProject;
    if (!opts.production) {
      const { readProject, applyProject, projectReference } = require('./production-project');
      const project = readProject(outDir);
      if (project) {
        config = applyProject(config, project);
        spec = validateEvidenceConfig(config);
        savedProject = projectReference(outDir, project);
      }
    }
    for (const delivery of spec.deliverables) if (delivery.kind === 'video') validateEditorial(delivery);
    const id = crypto.randomUUID();
    const runDir = path.join(outDir, 'runs', id);
    fs.mkdirSync(runDir, { recursive: true });
    const report = {
      version: 1, kind: 'take-a-repo.evidence-run', id, startedAt: new Date().toISOString(),
      scope: { full: scenes.length === 0, producers: scenes.length ? scenes : spec.producers.map((p) => p.id), deliverables: spec.deliverables.map((d) => d.id) },
      source: provenance(cwd, config), producers: [], claims: [], deliverables: [], files: [], actions: [],
      machineStatus: 'needs-fix',
    };
    const production = opts.production;
    if (production) report.production = production.record;
    else if (savedProject) report.production = { project: savedProject };
    const pointer = path.join(outDir, 'take-a-repo-evidence.json');
    const previous = readJsonIfExists(pointer);
    if (previous?.id) report.previousRunId = previous.id;
    writeJson(pointer, { version: 1, id, state: 'running', run: `runs/${id}/run.json` });
    try {
      if (spec.inputs) {
        report.freshness = { root: path.relative(outDir, cwd), ...fingerprintInputs(cwd, spec.inputs) };
        if (opts.noBuild && config.build) throw new Error('evidence with declared inputs requires a fresh build');
      }
      if (config.build && production?.reusedBuild) {
        report.build = production.reusedBuild;
        log('reuse unchanged build');
      } else if (config.build && !opts.noBuild) {
        // Same committed-command trust boundary as legacy config.build.
        report.build = {
          command: config.build, startedAt: new Date().toISOString(),
          ...await execute(process.platform === 'win32' ? ['cmd', '/c', config.build] : ['/bin/sh', '-c', config.build], { cwd, outDir: runDir }),
          finishedAt: new Date().toISOString(),
        };
        if (report.build.exitCode !== 0 || report.build.error) throw new Error(`build failed: ${report.build.error || report.build.exitCode}`);
      }
      if (spec.buildOutputs) report.buildFingerprint = fingerprintInputs(cwd, spec.buildOutputs);
      for (const producer of spec.producers) {
        if (scenes.length && !scenes.includes(producer.id)) continue;
        log(`collect ${producer.kind}: ${producer.id}`);
        const result = production
          ? await production.collect(producer, { cwd, runDir, log }, report)
          : await runProducer(producer, { cwd, runDir, log });
        report.producers.push(result);
        if (result.status === 'failed') report.actions.push({ code: 'producer-failed', owner: 'agent', producer: producer.id, fix: result.error || 'fix the failing producer checks', retryScenes: [producer.id] });
      }
      report.claims = resolveClaims(spec, report.producers);
      for (const claim of report.claims.filter((c) => c.status !== 'verified')) {
        report.actions.push({ code: 'claim-not-verified', owner: 'agent', claim: claim.id, fix: 'execute the referenced checks against the product; do not mark imports as passed', retryScenes: [...new Set(claim.checks.map((ref) => ref.split(':')[0]))] });
      }
      for (const delivery of spec.deliverables) {
        try {
          const rendered = production
            ? await production.render(delivery, report, runDir)
            : { files: await renderProductionDeliverable(delivery, report, runDir, cwd) };
          const { files, ...renderMetadata } = rendered;
          report.deliverables.push({ ...delivery, ...renderMetadata, status: 'rendered', files: files.map((f) => f.path) });
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
      if (report.freshness && fingerprintInputs(cwd, spec.inputs).digest !== report.freshness.digest) throw new Error('capture inputs changed during execution; recapture');
      if (report.buildFingerprint && fingerprintInputs(cwd, spec.buildOutputs).digest !== report.buildFingerprint.digest) throw new Error('build changed during execution; recapture');
      if (production) production.verify();
      if (savedProject && sha256File(path.join(outDir, savedProject.path)) !== savedProject.sha256) throw new Error('production project changed during execution');
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
    report.editorialReviewRequired = report.deliverables.some((d) => d.kind === 'video');
    const manifest = path.join(runDir, 'run.json');
    writeJson(manifest, report);
    writeJson(pointer, { version: 1, id, state: 'completed', run: `runs/${id}/run.json`, sha256: sha256File(manifest) });
    // The run-session marker is still running until this callback returns.
    const editorialReview = { status: report.editorialReviewRequired ? 'pending' : 'not-required', authority: 'agent-review-only' };
    const status = report.machineStatus === 'publish-ready' ? (report.editorialReviewRequired ? 'needs-fix' : 'awaiting-approval') : report.machineStatus;
    const nextActions = [...report.actions, ...(report.machineStatus === 'publish-ready' && report.editorialReviewRequired
      ? [{ code: 'editorial-review-required', owner: 'agent', fix: 'Inspect production review-context, then record production review --report before presenting for approval.' }] : [])];
    log(`evidence ${id}: ${status}`);
    return { produced: [manifest, ...report.files.map((f) => path.join(runDir, f.path))], outDir, manifest, status, machineStatus: report.machineStatus, editorialReview, nextActions, exitCode: report.actions.length ? 1 : 0 };
  }, { projectToken: opts.production?.projectToken });
}

module.exports = { captureEvidence, resolveClaims };
