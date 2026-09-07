const fs = require('fs');
const path = require('path');
const { safeAssetPath, sha256File, readJsonIfExists } = require('./handoff-files');
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
  for (const asset of report.files) {
    try {
      const target = safeAssetPath(runDir, { outPath: asset.path });
      if (!target || sha256File(target) !== asset.sha256) throw new Error('digest mismatch');
    } catch (_error) { problems.push({ code: 'asset-integrity-mismatch', path: asset.path }); }
  }
  const reviewDigest = digest(`${pointer.sha256}:${report.assetSetDigest}`);
  const decision = readJsonIfExists(path.join(runDir, 'review.json'));
  const current = decision?.reviewDigest === reviewDigest;
  const ready = report.machineStatus === 'publish-ready' && !problems.length && report.scope.full;
  const status = !ready ? 'needs-fix' : current ? decision.status : 'awaiting-approval';
  return {
    id: report.id, status, machineStatus: report.machineStatus, publishable: ready && current && decision.status === 'approved',
    reviewDigest, scope: report.scope, problems, actions: report.actions,
    ...(current ? { feedback: decision.feedback || [], decision } : {}),
    report, runDir,
  };
}

module.exports = { evidenceState };
