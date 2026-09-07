/*
 * take-a-repo — demo video post-processing (mp4 conversion + trim + framing).
 *
 * X/Twitter and most SNS uploaders want H.264 MP4, not the vp8 webm that
 * Playwright records. Conversion needs a REAL ffmpeg: Playwright's bundled
 * ffmpeg is a minimal vp8-only build (no libx264 — verified empirically), so
 * we resolve, in order:
 *   1. TAKE_A_REPO_FFMPEG (explicit binary path)
 *   2. `ffmpeg` on PATH (GitHub ubuntu runners ship one; macOS: `brew install ffmpeg`)
 * If mp4/trim/crop/zoom/thumbnail was requested and no ffmpeg is found we fail
 * loudly with the install hint — a requested output is never silently skipped.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const INSTALL_HINT =
  'no ffmpeg found — install one (macOS: `brew install ffmpeg`; Debian/Ubuntu: ' +
  '`apt-get install -y ffmpeg`; GitHub ubuntu runners already have it) or set ' +
  "TAKE_A_REPO_FFMPEG to a binary. Playwright's bundled ffmpeg cannot encode H.264.";

// Bound each ffmpeg invocation so a wedged encoder (bad input, odd codec path,
// a binary that hangs on stdin) can't block the whole capture run forever.
// Override for legitimately long encodes via TAKE_A_REPO_FFMPEG_TIMEOUT_MS.
function ffmpegTimeoutMs(env = process.env) {
  const raw = Number(env.TAKE_A_REPO_FFMPEG_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/**
 * Run ffmpeg with a bounded timeout, turning a timeout into a clear error
 * (execFileSync otherwise throws a raw ETIMEDOUT/signal error on `.killed`).
 */
function runFfmpeg(bin, args, timeoutMs) {
  try {
    execFileSync(bin, args, {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    if (err && (err.killed || err.code === 'ETIMEDOUT')) {
      throw new Error(
        `take-a-repo: ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s — the encoder may be ` +
          'wedged. Raise TAKE_A_REPO_FFMPEG_TIMEOUT_MS for legitimately long encodes.',
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Locate a usable ffmpeg. Returns the binary path/name, or null.
 * @param {NodeJS.ProcessEnv} [env]
 */
function findFfmpeg(env = process.env) {
  for (const bin of [env.TAKE_A_REPO_FFMPEG, 'ffmpeg']) {
    if (!bin) continue;
    try {
      // `-version` returns near-instantly; a small timeout guards against a
      // resolved binary that wedges (e.g. hangs waiting on stdin).
      const r = spawnSync(bin, ['-version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        env,
        timeout: 10_000,
      });
      if (r.status === 0 && /ffmpeg version/i.test(r.stdout || '')) return bin;
    } catch (_e) {
      /* try the next candidate */
    }
  }
  return null;
}

function findFfprobe(env = process.env) {
  const sibling = env.TAKE_A_REPO_FFMPEG
    ? path.join(path.dirname(env.TAKE_A_REPO_FFMPEG), 'ffprobe')
    : null;
  for (const bin of [env.TAKE_A_REPO_FFPROBE, sibling, 'ffprobe']) {
    if (!bin) continue;
    try {
      const result = spawnSync(bin, ['-version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        env,
        timeout: 10_000,
      });
      if (result.status === 0 && /ffprobe version/i.test(result.stdout || '')) return bin;
    } catch (_err) {
      /* try the next candidate */
    }
  }
  return null;
}

function parseProbeOutput(stdout) {
  const data = JSON.parse(stdout);
  const stream = data.streams && data.streams[0];
  if (!stream) throw new Error('ffprobe returned no video stream');
  const durationSeconds = Number(data.format && data.format.duration);
  return {
    ok: true,
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
  };
}

function decodeVideo(filePath, env = process.env) {
  const bin = findFfmpeg(env);
  if (!bin) {
    return {
      ok: false,
      error: 'final MP4 decode was not verified because ffmpeg was not found',
    };
  }
  const result = spawnSync(bin, [
    '-hide_banner',
    '-loglevel', 'error',
    '-xerror',
    '-err_detect', 'explode',
    '-i', filePath,
    '-map', '0:v:0',
    '-f', 'null',
    '-',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    env,
    timeout: ffmpegTimeoutMs(env),
  });
  if (result.status === 0) return { ok: true };
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.error.killed)) {
    return {
      ok: false,
      error: `final MP4 decode timed out after ${Math.round(ffmpegTimeoutMs(env) / 1000)}s`,
    };
  }
  const detail = String(result.stderr || (result.error && result.error.message) || `ffmpeg exited ${result.status}`)
    .trim()
    .slice(-2000);
  return {
    ok: false,
    error: `final MP4 failed full decode${detail ? `: ${detail}` : ''}`,
  };
}

function probeVideo(filePath, env = process.env) {
  const bin = findFfprobe(env);
  if (!bin) {
    return { ok: false, error: 'no ffprobe found; install ffmpeg or set TAKE_A_REPO_FFPROBE' };
  }
  const result = spawnSync(bin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,width,height:format=duration',
    '-of', 'json',
    filePath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env,
    timeout: 20_000,
  });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || `ffprobe exited ${result.status}`).trim() };
  }
  try {
    const media = parseProbeOutput(result.stdout);
    const decode = decodeVideo(filePath, env);
    return decode.ok ? media : { ...media, ok: false, error: decode.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Build the ffmpeg argv. Pure (unit-tested).
 *
 * @param {object} o
 * @param {string} o.input
 * @param {string} o.output
 * @param {{start?: string|number, duration?: string|number}} [o.trim]
 * @param {number} [o.crf=23]  H.264 quality (lower = better/larger)
 * @param {{x:number,y:number,width:number,height:number}} [o.crop]
 * @param {number|{scale?: number, x?: string|number, y?: string|number}} [o.zoom]
 * @param {boolean} [o.copy=false]  stream-copy (no re-encode) — for webm-only trims
 */
function buildFfmpegArgs({ input, output, trim, crf = 23, crop, zoom, copy = false }) {
  if (!copy && (!Number.isFinite(Number(crf)) || Number(crf) < 0 || Number(crf) > 63)) {
    throw new Error('take-a-repo: demo.mp4.crf must be a number between 0 and 63');
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  // -ss before -i = fast keyframe seek; with re-encode it is frame-accurate.
  if (trim && trim.start != null) args.push('-ss', String(trim.start));
  args.push('-i', input);
  if (trim && trim.duration != null) args.push('-t', String(trim.duration));
  if (copy) {
    args.push('-c', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-vf', buildVideoFilter({ crop, zoom }),
      '-movflags', '+faststart',
      // Screencasts are silent; skipping the audio track avoids any AAC
      // encoder dependency and SNS uploaders accept silent H.264 fine.
      '-an',
    );
  }
  args.push(output);
  return args;
}

function buildVideoFilter({ crop, zoom } = {}) {
  const filters = [];
  if (crop) {
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(crop[key])) throw new Error(`take-a-repo: demo.crop.${key} must be a finite number`);
    }
    if (crop.width <= 0 || crop.height <= 0) {
      throw new Error('take-a-repo: demo.crop.width and demo.crop.height must be greater than 0');
    }
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  }
  if (zoom) {
    const scale = typeof zoom === 'number' ? zoom : zoom.scale;
    if (!Number.isFinite(scale) || scale <= 1) throw new Error('take-a-repo: demo.zoom scale must be > 1');
    for (const key of ['x', 'y']) {
      if (typeof zoom === 'object' && typeof zoom[key] === 'number' && !Number.isFinite(zoom[key])) {
        throw new Error(`take-a-repo: demo.zoom.${key} must be a finite number`);
      }
    }
    const x = typeof zoom === 'object' && zoom.x != null ? zoom.x : `(iw-iw/${scale})/2`;
    const y = typeof zoom === 'object' && zoom.y != null ? zoom.y : `(ih-ih/${scale})/2`;
    filters.push(`crop=iw/${scale}:ih/${scale}:${x}:${y}`);
    filters.push(`scale=ceil(iw*${scale}/2)*2:ceil(ih*${scale}/2)*2`);
  }
  // libx264 + yuv420p require even dimensions; presets are even already, this
  // final scale filter is insurance for custom viewports/crops.
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  return filters.join(',');
}

function buildThumbnailArgs({ input, output, at = 1 }) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', output];
}

function replaceFile(tmpPath, finalPath) {
  fs.rmSync(finalPath, { force: true });
  fs.renameSync(tmpPath, finalPath);
}

function tempSibling(filePath) {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  return `${base}.tmp-${process.pid}-${Date.now()}${ext}`;
}

/**
 * Post-process a recorded demo webm per config:
 *   - mp4 requested → write `<name>.mp4` next to the webm (trim applied there)
 *   - trim only     → stream-copy trim the webm in place
 *   - thumbnail     → write `<name>-thumbnail.png` from the final clip
 *
 * @param {object} o
 * @param {string} o.webmPath  the recorded demo .webm
 * @param {boolean|{crf?: number}} [o.mp4]
 * @param {{start?: string|number, duration?: string|number}} [o.trim]
 * @param {{x:number,y:number,width:number,height:number}} [o.crop]
 * @param {number|{scale?: number, x?: string|number, y?: string|number}} [o.zoom]
 * @param {boolean|{at?: string|number, name?: string}} [o.thumbnail]
 * @param {(msg: string) => void} o.log
 * @param {NodeJS.ProcessEnv} [o.env]
 * @returns {string[]} extra produced file paths
 */
function postProcessDemo({ webmPath, mp4, trim, crop, zoom, thumbnail, log, env = process.env }) {
  if (!mp4 && !trim && !crop && !zoom && !thumbnail) return [];
  const bin = findFfmpeg(env);
  if (!bin) throw new Error(`demo mp4/trim/crop/zoom/thumbnail requested but ${INSTALL_HINT}`);

  const timeoutMs = ffmpegTimeoutMs(env);
  const produced = [];
  let finalVideoPath = webmPath;
  if (mp4 || crop || zoom) {
    const crf = typeof mp4 === 'object' && mp4.crf != null ? mp4.crf : undefined;
    const mp4Path = webmPath.replace(/\.webm$/, '.mp4');
    const tmpMp4Path = tempSibling(mp4Path);
    try {
      runFfmpeg(bin, buildFfmpegArgs({ input: webmPath, output: tmpMp4Path, trim, crf, crop, zoom }), timeoutMs);
      replaceFile(tmpMp4Path, mp4Path);
    } catch (err) {
      fs.rmSync(tmpMp4Path, { force: true });
      throw err;
    }
    produced.push(mp4Path);
    finalVideoPath = mp4Path;
    const notes = ['H.264'];
    if (trim) notes.push('trimmed');
    if (crop) notes.push('cropped');
    if (zoom) notes.push('zoomed');
    log(`✓ ${path.basename(mp4Path)} (${notes.join(', ')})`);
  } else if (trim) {
    // Trim-only: stream-copy to a sibling temp file, then swap in place.
    const tmp = tempSibling(webmPath);
    try {
      runFfmpeg(bin, buildFfmpegArgs({ input: webmPath, output: tmp, trim, copy: true }), timeoutMs);
      replaceFile(tmp, webmPath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    log(`✓ ${path.basename(webmPath)} trimmed in place`);
  }
  // else: thumbnail-only (no mp4/crop/zoom/trim) — nothing to re-encode; the
  // thumbnail below is taken from the original webm without rewriting it.
  if (thumbnail) {
    const at = typeof thumbnail === 'object' && thumbnail.at != null ? thumbnail.at : 1;
    const thumbPath = typeof thumbnail === 'object' && thumbnail.name
      ? path.join(path.dirname(webmPath), thumbnail.name)
      : webmPath.replace(/\.webm$/, '-thumbnail.png');
    const tmpThumbPath = tempSibling(thumbPath);
    try {
      runFfmpeg(bin, buildThumbnailArgs({ input: finalVideoPath, output: tmpThumbPath, at }), timeoutMs);
      if (fs.existsSync(tmpThumbPath)) replaceFile(tmpThumbPath, thumbPath);
    } catch (err) {
      fs.rmSync(tmpThumbPath, { force: true });
      throw err;
    }
    // ffmpeg exits 0 even when `at` seeks past the end of a (trimmed) clip,
    // writing no file. Only record the thumbnail when it was actually produced,
    // so the manifest never references a phantom asset.
    if (fs.existsSync(thumbPath)) {
      produced.push(thumbPath);
      log(`✓ ${path.basename(thumbPath)} (thumbnail @ ${at}s)`);
    } else {
      log(`⚠️  thumbnail @ ${at}s not written (seek past end of clip?) — skipped`);
    }
  }
  return produced;
}

module.exports = {
  ffmpegTimeoutMs,
  findFfmpeg,
  findFfprobe,
  decodeVideo,
  parseProbeOutput,
  probeVideo,
  buildFfmpegArgs,
  buildThumbnailArgs,
  buildVideoFilter,
  postProcessDemo,
  INSTALL_HINT,
};
