const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeJson(filePath, data) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

function readJsonIfExists(filePath) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch (_err) {
    return null;
  }
}

function mergeByKey(previous, current, keyOf) {
  if (!Array.isArray(previous) || !previous.length) return current;
  const currentKeys = new Set(current.map(keyOf));
  const retained = previous.filter((item) => item && !currentKeys.has(keyOf(item)));
  return [...retained, ...current];
}

function namesMatch(left, right) {
  const a = new Set((left || []).map((item) => item && item.name).filter(Boolean));
  const b = new Set((right || []).map((item) => item && item.name).filter(Boolean));
  return a.size === b.size && [...a].every((name) => b.has(name));
}

function copyHandoffSchemas(outDir, schemaFiles) {
  const schemaDir = path.join(outDir, 'schemas');
  fs.mkdirSync(schemaDir, { recursive: true });
  return Object.values(schemaFiles).map((relativePath) => {
    const target = path.join(outDir, relativePath);
    const source = path.join(__dirname, '..', 'schemas', path.basename(relativePath));
    fs.copyFileSync(source, target);
    return target;
  });
}

function safeAssetPath(outDir, asset) {
  if (!asset || typeof asset.outPath !== 'string') return null;
  const target = path.resolve(outDir, asset.outPath);
  const relative = path.relative(outDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (fs.existsSync(target)) {
    const realRelative = path.relative(fs.realpathSync(outDir), fs.realpathSync(target));
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
  }
  return target;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function hydrateManifestAssets(assets, outDir, manifestPath) {
  const manifestTarget = path.resolve(manifestPath);
  return assets.flatMap((asset) => {
    const filePath = safeAssetPath(outDir, asset);
    if (!filePath) return [];
    // A manifest cannot contain a stable digest of itself.
    if (filePath === manifestTarget) return [asset];
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return [];
    const digest = sha256File(filePath);
    if (asset.state === 'retained' && asset.integrity && asset.integrity.digest !== digest) {
      return [{
        ...asset,
        state: 'modified',
        observed: {
          bytes: stat.size,
          integrity: { algorithm: 'sha256', digest },
        },
      }];
    }
    // The disk writer is a validation boundary, including for programmatic
    // callers. Never trust supplied `media.ok` or `visual.nonBlank` metadata.
    const measured = {};
    if (asset.target || asset.source?.target) {
      if (asset.role === 'sns-demo-mp4') measured.media = require('./video').probeVideo(filePath);
      if (asset.role === 'thumbnail') measured.visual = require('./image-qa').analyzePng(filePath);
    }
    return [{
      ...asset,
      ...measured,
      bytes: stat.size,
      integrity: { algorithm: 'sha256', digest },
    }];
  });
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`handoff has duplicate asset ${label}: ${value}`);
    seen.add(value);
  }
}

function validateFinalPack(docs, outDir, manifestPath) {
  if (!namesMatch(docs.storyboard.demos, docs.captions.demos)) {
    throw new Error('handoff storyboard and captions demo sets do not match');
  }
  assertUnique(docs.manifest.assets, 'id', 'id');
  assertUnique(docs.manifest.assets, 'outPath', 'outPath');
  const ids = new Set(docs.manifest.assets.map((asset) => asset.id));
  for (const asset of docs.manifest.assets) {
    const filePath = safeAssetPath(outDir, asset);
    if (!filePath) throw new Error(`handoff asset escapes outDir: ${asset.outPath}`);
    if (path.resolve(filePath) === path.resolve(manifestPath)) continue;
    if (!fs.existsSync(filePath) || !asset.integrity || !Number.isInteger(asset.bytes)) {
      throw new Error(`handoff asset is missing integrity metadata: ${asset.id}`);
    }
  }
  for (const hint of docs.manifest.handoff.adapterHints) {
    for (const asset of hint.useAssets) {
      if (!ids.has(asset.id)) throw new Error(`adapter hint references unknown asset: ${asset.id}`);
    }
  }
}

module.exports = {
  copyHandoffSchemas,
  hydrateManifestAssets,
  mergeByKey,
  namesMatch,
  readJsonIfExists,
  safeAssetPath,
  sha256File,
  validateFinalPack,
  writeJson,
};
