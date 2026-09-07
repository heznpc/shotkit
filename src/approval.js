const fs = require('fs');
const path = require('path');

const crypto = require('crypto');
const { writeJson, safeAssetPath, sha256File, readJsonIfExists } = require('./handoff-files');

const APPROVAL_VERSION = 1;
const APPROVAL_KIND = 'take-a-repo.approval';
const APPROVAL_SCHEMA_ID = 'urn:starter-series:take-a-repo:schema:approval:v1';
const APPROVAL_FILE = 'take-a-repo-approval.json';
const DECISION_STATUSES = new Set(['approved', 'changes-requested']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function emptyApprovalDocument() {
  return {
    $schema: APPROVAL_SCHEMA_ID,
    version: APPROVAL_VERSION,
    kind: APPROVAL_KIND,
    decisions: {},
  };
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`take-a-repo: ${name} must be a non-empty string`);
  return value.trim();
}

function approvalKey(value, name) {
  const key = nonEmptyString(value, name);
  if (UNSAFE_KEYS.has(key)) throw new Error(`take-a-repo: ${name} uses a reserved key`);
  return key;
}

function normalizeDecision(decision, name = 'approval decision') {
  if (!isObject(decision)) throw new Error(`take-a-repo: ${name} must be an object`);
  if (!DECISION_STATUSES.has(decision.status)) {
    throw new Error(`take-a-repo: ${name}.status must be "approved" or "changes-requested"`);
  }
  const assetDigest = nonEmptyString(decision.assetDigest, `${name}.assetDigest`);
  if (!/^[a-f0-9]{64}$/i.test(assetDigest)) throw new Error(`take-a-repo: ${name}.assetDigest must be a SHA-256 digest`);
  const decidedAt = nonEmptyString(decision.decidedAt, `${name}.decidedAt`);
  if (Number.isNaN(Date.parse(decidedAt))) throw new Error(`take-a-repo: ${name}.decidedAt must be an ISO date-time`);
  const note = decision.note == null ? '' : String(decision.note).trim();
  if (decision.status === 'changes-requested' && !note) {
    throw new Error(`take-a-repo: ${name}.note is required when changes are requested`);
  }
  if (note.length > 2000) throw new Error(`take-a-repo: ${name}.note must be at most 2000 characters`);
  return {
    status: decision.status,
    assetDigest: assetDigest.toLowerCase(),
    ...(decision.profileHash ? { profileHash: nonEmptyString(decision.profileHash, `${name}.profileHash`) } : {}),
    decidedAt,
    ...(note ? { note } : {}),
  };
}

function normalizeApprovalDocument(document) {
  if (!isObject(document)) throw new Error('take-a-repo: approval document must be an object');
  if (document.$schema !== APPROVAL_SCHEMA_ID) throw new Error(`take-a-repo: approval $schema must be ${APPROVAL_SCHEMA_ID}`);
  if (document.version !== APPROVAL_VERSION) throw new Error(`take-a-repo: approval version must be ${APPROVAL_VERSION}`);
  if (document.kind !== APPROVAL_KIND) throw new Error(`take-a-repo: approval kind must be ${APPROVAL_KIND}`);
  if (!isObject(document.decisions)) throw new Error('take-a-repo: approval decisions must be an object');
  const decisions = {};
  for (const [story, targets] of Object.entries(document.decisions)) {
    const normalizedStory = approvalKey(story, 'approval story key');
    if (!isObject(targets)) throw new Error(`take-a-repo: approval decisions.${story} must be an object`);
    decisions[normalizedStory] = {};
    for (const [target, decision] of Object.entries(targets)) {
      const normalizedTarget = approvalKey(target, `approval decisions.${story} target key`);
      decisions[normalizedStory][normalizedTarget] = normalizeDecision(
        decision,
        `approval decisions.${story}.${target}`,
      );
    }
  }
  return { $schema: APPROVAL_SCHEMA_ID, version: APPROVAL_VERSION, kind: APPROVAL_KIND, decisions };
}

function approvalPath(outDir) {
  return path.join(path.resolve(outDir), APPROVAL_FILE);
}

function loadApproval(outDir) {
  const filePath = approvalPath(outDir);
  if (!fs.existsSync(filePath)) return { path: filePath, document: emptyApprovalDocument() };
  try {
    return { path: filePath, document: normalizeApprovalDocument(JSON.parse(fs.readFileSync(filePath, 'utf8'))) };
  } catch (error) {
    throw new Error(`take-a-repo: could not load approval file: ${error.message}`, { cause: error });
  }
}

function updateApprovalDecisions(outDir, updates, now = () => new Date()) {
  if (!Array.isArray(updates) || !updates.length) {
    throw new Error('take-a-repo: approval updates must be a non-empty array');
  }
  const decidedAt = now().toISOString();
  const normalizedUpdates = updates.map((update, index) => ({
    story: approvalKey(update.story, `approval updates[${index}].story`),
    target: approvalKey(update.target, `approval updates[${index}].target`),
    decision: normalizeDecision({
      ...update.decision,
      decidedAt: update.decision.decidedAt || decidedAt,
    }, `approval updates[${index}].decision`),
  }));
  const loaded = loadApproval(outDir);
  for (const update of normalizedUpdates) {
    if (!Object.prototype.hasOwnProperty.call(loaded.document.decisions, update.story)) {
      loaded.document.decisions[update.story] = {};
    }
    loaded.document.decisions[update.story][update.target] = update.decision;
  }
  writeJson(loaded.path, loaded.document);
  return { ...loaded, updates: normalizedUpdates };
}

function updateApprovalDecision(outDir, story, target, decision) {
  const updated = updateApprovalDecisions(outDir, [{ story, target, decision }]);
  return { ...updated, decision: updated.updates[0].decision };
}

function decisionFor(document, story, target) {
  return document.decisions && document.decisions[story] ? document.decisions[story][target] || null : null;
}

function targetAssetDigest(manifest, target, outDir) {
  const refs = [target.deliverable, target.thumbnail].filter(Boolean);
  if (!target.deliverable) return null;
  const digests = [];
  for (const ref of refs) {
    const asset = (manifest.assets || []).find((item) => item.id === ref.id);
    if (!asset || asset.state === 'modified' || asset.integrity?.algorithm !== 'sha256') return null;
    if (outDir) {
      try {
        const file = safeAssetPath(outDir, asset);
        if (!file || !fs.statSync(file).isFile() || sha256File(file) !== asset.integrity.digest) return null;
      } catch (_error) { return null; }
    }
    digests.push([ref.id, asset.integrity.digest]);
  }
  // One-file legacy decisions stay compatible. Multi-file delivery approvals
  // bind BOTH video and poster; an old video-only decision needs fresh review.
  return digests.length === 1 ? digests[0][1]
    : crypto.createHash('sha256').update(JSON.stringify(digests)).digest('hex');
}

function approvalGate(manifest, document = emptyApprovalDocument(), options = {}) {
  const normalized = normalizeApprovalDocument(document);
  const automation = manifest.handoff && manifest.handoff.automation;
  const technicalTargets = automation && Array.isArray(automation.targets) ? automation.targets : [];
  const marker = options.outDir && path.join(options.outDir, '.take-a-repo-run.json');
  const runState = marker && readJsonIfExists(marker);
  const runReady = !marker || !fs.existsSync(marker) || runState?.status === 'completed';
  const targets = technicalTargets.map((target) => {
    const context = typeof options.targetContext === 'function' ? options.targetContext(target) || {} : {};
    const assetDigest = targetAssetDigest(manifest, target, options.outDir);
    const profileHash = Object.prototype.hasOwnProperty.call(context, 'profileHash')
      ? context.profileHash
      : target.profileHash || null;
    const decision = decisionFor(normalized, target.story, target.target);
    const current = !!(decision && assetDigest
      && decision.assetDigest === assetDigest
      && (decision.profileHash || null) === profileHash);
    let status = 'not-ready';
    if (runReady && target.status === 'publish-ready' && context.ready !== false && assetDigest) {
      status = current ? decision.status : 'awaiting-approval';
    }
    return {
      target: target.target,
      demo: target.demo,
      story: target.story,
      status,
      assetDigest,
      ...(profileHash ? { profileHash } : {}),
      stale: !!decision && !current,
      ...(current ? {
        decision: {
          status: decision.status,
          decidedAt: decision.decidedAt,
          ...(decision.note ? { note: decision.note } : {}),
        },
      } : {}),
    };
  });
  let status = 'not-requested';
  if (technicalTargets.length) {
    if (!automation || automation.status !== 'publish-ready') status = 'not-ready';
    else if (targets.some((target) => target.status === 'not-ready')) status = 'not-ready';
    else if (targets.some((target) => target.status === 'changes-requested')) status = 'changes-requested';
    else if (targets.every((target) => target.status === 'approved')) status = 'approved';
    else status = 'awaiting-approval';
  }
  return {
    required: technicalTargets.length > 0,
    status,
    file: APPROVAL_FILE,
    userActionRequired: status === 'awaiting-approval',
    publishable: status === 'approved',
    targets,
  };
}

function syncManifestApproval(manifest, document = emptyApprovalDocument(), options = {}) {
  if (!manifest.handoff) manifest.handoff = {};
  manifest.handoff.approval = approvalGate(manifest, document, options);
  if (manifest.handoff.summary) {
    manifest.handoff.summary.approvedTargetCount = manifest.handoff.approval.targets
      .filter((target) => target.status === 'approved').length;
  }
  return manifest.handoff.approval;
}

function deliveryStatus(manifest) {
  const automation = manifest.handoff && manifest.handoff.automation;
  if (!automation || automation.status !== 'publish-ready') return automation ? automation.status : 'not-requested';
  return manifest.handoff.approval ? manifest.handoff.approval.status : 'awaiting-approval';
}

module.exports = {
  APPROVAL_FILE,
  APPROVAL_KIND,
  APPROVAL_SCHEMA_ID,
  APPROVAL_VERSION,
  approvalGate,
  approvalPath,
  deliveryStatus,
  emptyApprovalDocument,
  loadApproval,
  normalizeApprovalDocument,
  normalizeDecision,
  syncManifestApproval,
  updateApprovalDecision,
  updateApprovalDecisions,
};
