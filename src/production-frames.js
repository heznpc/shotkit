const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { findFfmpeg, ffmpegTimeoutMs } = require('./video');
const { digest } = require('./evidence-contract');
const { sha256File, safeAssetPath, readJsonIfExists, writeJson } = require('./handoff-files');

function observationTool() {
  const bin = findFfmpeg();
  if (!bin) throw new Error('production observe requires ffmpeg');
  const result = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error('cannot identify observation ffmpeg');
  return { bin, fingerprint: digest(result.stdout) };
}

function extractObservationFrames(source, directory, recipe, tool) {
  // Keep actual presentation timestamps, including variable-frame-rate input.
  // Sampling is bounded; it does not claim to detect every event or scene cut.
  const filter = `setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${recipe.intervalSeconds})',scale=w='min(${recipe.width},iw)':h='min(${recipe.width},ih)':force_original_aspect_ratio=decrease,showinfo`;
  const result = spawnSync(tool.bin, [
    '-hide_banner', '-nostdin', '-i', source, '-map', '0:v:0', '-an',
    '-vf', filter, '-fps_mode', 'vfr', '-frames:v', String(recipe.maxFrames),
    path.join(directory, 'frame-%04d.png'),
  ], { encoding: 'utf8', timeout: ffmpegTimeoutMs(), maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' });
  if (result.status !== 0) throw new Error(`observation extraction failed: ${result.error?.message || result.stderr?.slice(-2000)}`);
  const timestamps = [...result.stderr.matchAll(/\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*([\d.eE+-]+)/g)].map((match) => Number(match[1]));
  const files = fs.readdirSync(directory).filter((file) => /^frame-\d+\.png$/.test(file)).sort();
  if (!files.length || files.length > recipe.maxFrames || timestamps.length < files.length) throw new Error('observation frames or timestamps are missing');
  return files.map((file, i) => {
    const target = path.join(directory, file);
    const png = PNG.sync.read(fs.readFileSync(target));
    return { atSeconds: timestamps[i], path: file, sha256: sha256File(target), bytes: fs.statSync(target).size, width: png.width, height: png.height };
  });
}

// Detail requests sample the actual video, never a previously thinned grid.
// Cache by source bytes, decoder and recipe so repeat critiques do no media work.
function selectedObservationFrames(source, outDir, { times, width = 1280, crop = null }, tool) {
  if (!Array.isArray(times) || !times.length || times.length > 32 || times.some((at) => !Number.isFinite(at) || at < 0)
    || !Number.isInteger(width) || width < 160 || width > 1920) throw new Error('detail frames require 1..32 nonnegative times and width 160..1920');
  if (crop && (!['x', 'y', 'width', 'height'].every((k) => Number.isInteger(crop[k])) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0)) throw new Error('invalid detail crop');
  // Validate cheap caller input before spawning even a tool-version process.
  tool ||= observationTool();
  const sha256 = sha256File(source);
  const key = digest(JSON.stringify({ version: 2, sha256, tool: tool.fingerprint, times, width, crop }));
  const root = safeAssetPath(outDir, { outPath: 'detail-frames' });
  if (!root) throw new Error('detail frames must stay inside output directory');
  fs.mkdirSync(root, { recursive: true });
  const pointer = safeAssetPath(root, { outPath: `${key}.json` });
  if (!pointer) throw new Error('unsafe detail index');
  const cached = readJsonIfExists(pointer);
  if (cached?.key === key && Array.isArray(cached.frames) && cached.frames.length === times.length && cached.frames.every((frame, index) => {
    try { const file = safeAssetPath(root, { outPath: frame.path }); return frame.requestedAtSeconds === times[index] && file && sha256File(file) === frame.sha256; } catch { return false; }
  })) return cached.frames.map((frame) => ({ ...frame, path: path.resolve(root, frame.path) }));
  const directory = fs.mkdtempSync(path.join(root, 'frames-'));
  try {
    const frames = times.map((at, index) => {
      const target = path.join(directory, `${index}.png`);
      const filter = `${crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` : ''}scale=w='min(${width},iw)':h=-1,showinfo`;
      const result = spawnSync(tool.bin, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-ss', String(at), '-i', source,
        '-vf', filter, '-frames:v', '1', target], { encoding: 'utf8', timeout: ffmpegTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      if (result.status !== 0 || !fs.existsSync(target)) throw new Error(`detail extraction failed at ${at}: ${result.stderr || result.error?.message || 'no frame'}`);
      const timestamp = result.stderr.match(/\bn:\s*0\s+pts:\s*\S+\s+pts_time:\s*([\d.eE+-]+)/);
      if (!timestamp || !Number.isFinite(Number(timestamp[1]))) throw new Error('detail frame has no presentation timestamp');
      // Input seeking rebases PTS to the requested seek. Report the actual decoded
      // frame time, which can differ substantially on sparse or variable-rate video.
      const atSeconds = Math.round((at + Number(timestamp[1])) * 1000) / 1000;
      const png = PNG.sync.read(fs.readFileSync(target));
      return { id: `${key.slice(0, 16)}-${index}`, atSeconds, requestedAtSeconds: at, path: path.relative(root, target), sha256: sha256File(target), width: png.width, height: png.height };
    });
    if (sha256File(source) !== sha256) throw new Error('video changed during detail extraction');
    writeJson(pointer, { key, frames });
    return frames.map((frame) => ({ ...frame, path: path.resolve(root, frame.path) }));
  } catch (error) {
    // Failed detail requests are not reusable observations. Keep the previous
    // cache pointer and remove only this request's incomplete intermediates.
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { observationTool, extractObservationFrames, selectedObservationFrames };
