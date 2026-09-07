const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv = require('ajv');
const { safeAssetPath, sha256File } = require('./handoff-files');
const { analyzePng } = require('./image-qa');
const { probeVideo } = require('./video');

const validate = new Ajv({ allErrors: true }).compile(require('../schemas/evidence.schema.json'));
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const EXTENSIONS = {
  'image/png': ['.png'], 'video/mp4': ['.mp4'], 'video/webm': ['.webm'], 'video/quicktime': ['.mov'],
  'application/json': ['.json'], 'text/plain': ['.txt', '.log'], 'text/markdown': ['.md'],
};

function uniqueIds(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} must be an array`);
  const ids = new Set();
  for (const item of items) {
    if (!ID.test(item.id) || ids.has(item.id)) throw new Error(`${label}: invalid or duplicate id ${item.id}`);
    ids.add(item.id);
  }
}

function validateEvidenceConfig(config) {
  const spec = config.evidence;
  if (!spec || spec.version !== 1) throw new Error('evidence.version must be 1');
  uniqueIds(spec.producers, 'producers');
  uniqueIds(spec.claims, 'claims');
  uniqueIds(spec.deliverables, 'deliverables');
  if (!spec.producers.length || !spec.claims.length || !spec.deliverables.length) throw new Error('evidence needs producers, claims and deliverables');
  for (const producer of spec.producers) {
    if (!['browser', 'native', 'cli', 'api'].includes(producer.kind)) throw new Error(`invalid producer kind: ${producer.kind}`);
    if ([producer.command, producer.import, producer.capture].filter(Boolean).length !== 1) {
      throw new Error(`${producer.id}: choose exactly one command, import, or browser capture`);
    }
    if (producer.command && (!Array.isArray(producer.command) || !producer.command.length
      || producer.command.some((arg) => typeof arg !== 'string' || !arg.length))) throw new Error('producer command must be an argv array');
    if (producer.capture && (producer.kind !== 'browser' || producer.capture.evidence)) throw new Error('capture adapter requires a non-nested browser config');
    if (producer.timeoutMs != null && (!Number.isInteger(producer.timeoutMs) || producer.timeoutMs < 1 || producer.timeoutMs > 3_600_000)) {
      throw new Error('producer timeoutMs must be 1..3600000');
    }
  }
  const producers = new Set(spec.producers.map((p) => p.id));
  const claims = new Set(spec.claims.map((c) => c.id));
  for (const claim of spec.claims) {
    if (typeof claim.text !== 'string' || !claim.text.trim() || !Array.isArray(claim.checks) || !claim.checks.length) {
      throw new Error(`${claim.id}: claim requires text and check references`);
    }
    for (const ref of claim.checks) {
      if (typeof ref !== 'string' || !producers.has(ref.split(':')[0]) || !ID.test(ref.split(':')[1]) || ref.split(':').length !== 2) {
        throw new Error(`unknown check producer/reference: ${ref}`);
      }
    }
  }
  for (const delivery of spec.deliverables) {
    if (!['proof', 'video'].includes(delivery.kind)) throw new Error('deliverable kind must be proof or video');
    if (!Array.isArray(delivery.claims) || delivery.claims.some((id) => !claims.has(id))) throw new Error('deliverable references unknown claims');
    if (delivery.kind === 'video' && (!delivery.source || !delivery.channel)) throw new Error('video requires source and channel');
  }
  return spec;
}

function readEvidence(file) {
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('evidence.json exceeds 1 MiB');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!validate(value)) throw new Error(`invalid producer evidence: ${JSON.stringify(validate.errors)}`);
  uniqueIds(value.assets, 'assets');
  uniqueIds(value.checks, 'checks');
  const ids = new Set(value.assets.map((a) => a.id));
  const paths = new Set();
  for (const asset of value.assets) {
    if (path.isAbsolute(asset.path) || asset.path.split(/[\\/]/).includes('..')) throw new Error('asset path must be relative and contained');
    const normalized = path.normalize(asset.path);
    if (paths.has(normalized)) throw new Error('duplicate asset path');
    paths.add(normalized);
  }
  for (const check of value.checks) {
    if (check.assets.some((id) => !ids.has(id))) throw new Error(`check ${check.id} references unknown asset`);
  }
  return value;
}

function measureAsset(root, asset) {
  const file = safeAssetPath(root, { outPath: asset.path });
  if (!file || !fs.statSync(file).isFile()) throw new Error(`unsafe/missing asset: ${asset.path}`);
  const bytes = fs.statSync(file).size;
  if (!bytes || bytes > (asset.mediaType.startsWith('video/') ? 4 * 1024 ** 3 : 64 * 1024 ** 2)) throw new Error(`asset size out of bounds: ${asset.path}`);
  if (!EXTENSIONS[asset.mediaType]?.includes(path.extname(file).toLowerCase())) throw new Error(`asset extension does not match ${asset.mediaType}`);
  let qa;
  if (asset.mediaType === 'image/png') {
    qa = analyzePng(file);
    if (!qa.ok || !qa.nonBlank) throw new Error(`invalid/blank image: ${asset.path}`);
  } else if (asset.mediaType.startsWith('video/')) {
    qa = probeVideo(file);
    if (!qa.ok || !(qa.durationSeconds > 0)) throw new Error(`invalid video: ${qa.error || asset.path}`);
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    if (asset.mediaType === 'application/json') JSON.parse(text);
    qa = { ok: true, encoding: 'utf-8' };
  }
  return { ...asset, bytes, sha256: sha256File(file), qa };
}

module.exports = { validateEvidenceConfig, readEvidence, measureAsset, digest, uniqueIds };
