const fs = require('fs');
const path = require('path');
const { safeAssetPath, sha256File, readJsonIfExists } = require('./handoff-files');
const { fingerprintInputs, fingerprintEnvironment } = require('./evidence-inputs');
const { digest } = require('./evidence-contract');

function evidenceState(outDir) {
  outDir = path.resolve(outDir);
  const pointer = readJsonIfExists(path.join(outDir, 'take-a-repo-evidence.json'));
  if (!pointer) throw new Error('no evidence run found');
  const marker = path.join(outDir, '.take-a-repo-run.json');
  const runState = readJsonIfExists(marker);
  if (pointer.state !== 'completed' || (fs.existsSync(marker) && runState?.status !== 'completed')) {
    return { status: 'not-ready', publishable: false, error: 'latest run is unfinished or failed', id: pointer.id };
  }
  const file = safeAssetPath(outDir, { outPath: pointer.run });
  if (!file || sha256File(file) !== pointer.sha256) throw new Error('run report integrity mismatch');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (report.kind !== 'take-a-repo.evidence-run' || report.version !== 1 || report.id !== pointer.id) throw new Error('invalid evidence run report');
  const runDir = path.dirname(file);
  const problems = [];
  if (report.production?.project) {
    const project = report.production.project;
    const current = safeAssetPath(outDir, { outPath: project.path });
    try {
      if (!current || sha256File(current) !== project.sha256) throw new Error('changed');
    } catch (_error) { problems.push({ code: 'project-changed-render-required' }); }
  }
  for (const producer of report.producers) {
    if (!producer.freshness) continue;
    try {
      const root = path.resolve(outDir, producer.freshness.root);
      if (fingerprintInputs(root, producer.freshness.inputs).digest !== producer.freshness.digest) {
        problems.push({ code: 'producer-inputs-changed', producer: producer.id });
      }
      const environment = producer.freshness.environment;
      if (environment && fingerprintEnvironment(environment.names).digest !== environment.digest) {
        problems.push({ code: 'producer-environment-changed', producer: producer.id });
      }
    } catch (error) { problems.push({ code: 'producer-inputs-unavailable', producer: producer.id, error: error.message }); }
  }
  if (report.production?.renderFreshness) {
    const expected = report.production.renderFreshness;
    try {
      if (fingerprintInputs(path.resolve(outDir, expected.root), expected.inputs).digest !== expected.digest) throw new Error('changed');
    } catch (_error) { problems.push({ code: 'caption-fonts-changed-render-required' }); }
  }
  for (const asset of report.files) {
    try {
      const target = safeAssetPath(runDir, { outPath: asset.path });
      if (!target || sha256File(target) !== asset.sha256) throw new Error('digest mismatch');
    } catch (_error) { problems.push({ code: 'asset-integrity-mismatch', path: asset.path }); }
  }
  if (report.freshness) {
    const root = path.resolve(outDir, report.freshness.root);
    for (const [kind, expected] of [['source', report.freshness], ['build', report.buildFingerprint]]) {
      if (!expected) continue;
      try {
        if (fingerprintInputs(root, expected.inputs).digest !== expected.digest) problems.push({ code: `${kind}-changed-recapture-required` });
      } catch (error) { problems.push({ code: `${kind}-unavailable`, error: error.message }); }
    }
  }
  const reviewDigest = digest(`${pointer.sha256}:${report.assetSetDigest}`);
  const decision = readJsonIfExists(path.join(runDir, 'review.json'));
  const current = decision?.reviewDigest === reviewDigest && ['approved', 'changes-requested'].includes(decision.status);
  const ready = report.machineStatus === 'publish-ready' && !problems.length && report.scope.full;
  const editorialReview = require('./production-review').reviewStatus(report, runDir, reviewDigest);
  const humanApprovalReady = ready && ['not-required', 'reviewed'].includes(editorialReview.status);
  const status = report.machineStatus === 'blocked' ? 'blocked' : !humanApprovalReady ? 'needs-fix' : current ? decision.status : 'awaiting-approval';
  return {
    id: report.id, status, machineStatus: report.machineStatus, publishable: humanApprovalReady && current && decision.status === 'approved',
    editorialReview, humanApprovalReady,
    reviewDigest, scope: report.scope, problems, actions: [...(report.actions || []), ...(ready && !humanApprovalReady ? [{ code: 'editorial-review-required', owner: 'agent', fix: 'Inspect production review-context, repair findings, then record production review --report before requesting user approval.' }] : [])],
    ...(current ? { feedback: decision.feedback || [], decision } : {}),
    report, runDir,
  };
}

module.exports = { evidenceState };
