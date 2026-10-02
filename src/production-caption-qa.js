const fs = require('fs');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');
const { ffmpegTimeoutMs } = require('./video');

const CAPTION_FPS = 30;

function captionFrameNumbers(captions) {
  return captions.map((caption) => {
    const first = Math.ceil(caption.start * CAPTION_FPS - 1e-8);
    const last = Math.ceil(caption.end * CAPTION_FPS - 1e-8) - 1;
    if (first > last) throw new Error(`caption ${caption.id} has no output frame; lengthen its time range`);
    return Math.max(first, Math.min(last, Math.floor((caption.start + caption.end) * CAPTION_FPS / 2)));
  });
}

function captionPixelError(expected, actual, { base = null, mask = null } = {}) {
  const frameBytes = expected.width * expected.height * 3;
  if (actual.length !== frameBytes || expected.data.length !== expected.width * expected.height * 4) throw new Error('caption QA frame is missing or incomplete');
  if (base && base.length !== frameBytes) throw new Error('caption QA source frame is missing or incomplete');
  if (mask && (mask.width !== expected.width || mask.height !== expected.height || mask.data.length !== expected.data.length)) throw new Error('caption QA mask dimensions do not match');
  let pixels = 0, error = 0;
  for (let pixel = 0; pixel < expected.width * expected.height; pixel++) {
    const rgba = pixel * 4, rgb = pixel * 3;
    const alphaByte = expected.data[rgba + 3];
    // A settled glyph mask keeps the entrance/exit area under observation even
    // at zero opacity. Without the clean source, only opaque glyphs are sound
    // references; translucent PNG colors are not final composited pixel colors.
    if (base && mask ? mask.data[rgba + 3] < 250 : alphaByte < 250) continue;
    pixels++;
    const alpha = alphaByte / 255;
    for (let channel = 0; channel < 3; channel++) {
      const composited = base
        ? alpha * expected.data[rgba + channel] + (1 - alpha) * base[rgb + channel]
        : expected.data[rgba + channel];
      error += Math.abs(composited - actual[rgb + channel]);
    }
  }
  if (!pixels) throw new Error('caption QA reference contains no visible text; animated transparency requires a source frame and glyph mask');
  return error / (pixels * 3);
}

function decodeCaptionFrames({ bin, input, frames, frameBytes, filter }) {
  const select = `select='${frames.map((frame) => `eq(n,${frame})`).join('+')}'`;
  const child = spawn(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, '-an',
    '-vf', `${filter ? `${filter},` : ''}${select}`, '-fps_mode', 'vfr', '-frames:v', String(frames.length),
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '', closed = false, timedOut = false;
  child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, ffmpegTimeoutMs());
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(`caption QA decoder ${timedOut ? 'timed out' : `failed (${signal || code})`}${diagnostic ? `: ${diagnostic.trim()}` : ''}`));
    });
  });
  // Process failure may precede consumption of stdout. Attach a rejection
  // handler immediately; the iterator still awaits and propagates the error.
  finished.catch(() => {});
  const cancel = () => {
    if (!closed) child.kill('SIGKILL');
    child.stdout.destroy();
  };
  async function* read() {
    let buffer = null, used = 0, count = 0;
    try {
      // Readable's async iterator supplies backpressure. Only a single frame
      // per decoder is assembled; no whole-video raw buffer is retained.
      for await (const chunk of child.stdout) {
        let offset = 0;
        while (offset < chunk.length) {
          if (!buffer) buffer = Buffer.allocUnsafe(frameBytes);
          const length = Math.min(frameBytes - used, chunk.length - offset);
          chunk.copy(buffer, used, offset, offset + length);
          offset += length;
          used += length;
          if (used === frameBytes) {
            count++;
            if (count > frames.length) throw new Error('caption QA decoder emitted extra frames');
            const frame = buffer;
            buffer = null;
            used = 0;
            yield frame;
          }
        }
      }
      await finished;
      if (used || count !== frames.length) throw new Error('caption QA could not decode every requested word frame');
    } catch (error) {
      cancel();
      // A killed/erroring process may close stdout before its close event.
      // Preserve the process/timeout diagnosis instead of a generic stream EOF.
      try { await finished; } catch (processError) { throw processError; }
      throw error;
    } finally { cancel(); }
  }
  return { iterator: read(), cancel, finished };
}

async function verifyCaptionTrack({ bin, video, samples, width, height, sourceVideo, sourceFilter }) {
  if (!samples.length) throw new Error('caption QA requires final-video samples');
  if (Boolean(sourceVideo) !== Boolean(sourceFilter)) throw new Error('caption QA requires both sourceVideo and sourceFilter');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('caption QA requires positive integer dimensions');
  const frameBytes = width * height * 3;
  const results = [];
  const ordered = [...samples].sort((a, b) => a.frame - b.frame);
  if (ordered.some((sample) => !Number.isInteger(sample.frame) || sample.frame < 0)) throw new Error('caption QA sample frames must be non-negative integers');
  const groups = new Map();
  for (const sample of ordered) {
    if (!groups.has(sample.frame)) groups.set(sample.frame, []);
    groups.get(sample.frame).push(sample);
  }
  const frames = [...groups.keys()];
  const decoders = [];
  try {
    decoders.push(decodeCaptionFrames({ bin, input: video, frames, frameBytes }));
    if (sourceVideo) decoders.push(decodeCaptionFrames({ bin, input: sourceVideo, frames, frameBytes, filter: sourceFilter }));
    // Both filters select the same unique, ordered frame indices. Consume one
    // frame from each in lockstep, irrespective of process arrival timing.
    for (const [frame, group] of groups) {
      const decoded = await Promise.all(decoders.map((decoder) => decoder.iterator.next()));
      if (decoded.some((item) => item.done)) throw new Error('caption QA could not decode every requested word frame');
      const actual = decoded[0].value, base = decoded[1]?.value;
      for (const sample of group) {
        const expected = PNG.sync.read(fs.readFileSync(sample.file));
        if (expected.width !== width || expected.height !== height) throw new Error('caption QA reference dimensions do not match the video');
        const mask = sample.maskFile ? PNG.sync.read(fs.readFileSync(sample.maskFile)) : null;
        const error = captionPixelError(expected, actual, { base, mask });
        if (error > 40) throw new Error(`caption ${sample.id} is missing or differs at frame ${frame}`);
        results.push({ id: sample.id, frame, atSeconds: frame / CAPTION_FPS, activeWordIndex: sample.activeWordIndex,
          ...(sample.phase ? { phase: sample.phase } : {}), meanPixelError: Math.round(error * 100) / 100 });
      }
    }
    // Producing the requested bytes alone is not success: require clean EOF
    // and successful exit from both decoders, including their final errors.
    const ends = await Promise.all(decoders.map((decoder) => decoder.iterator.next()));
    if (ends.some((item) => !item.done)) throw new Error('caption QA decoder emitted extra frames');
  } finally {
    for (const decoder of decoders) decoder.cancel();
    await Promise.allSettled(decoders.flatMap((decoder) => [decoder.iterator.return(), decoder.finished]));
  }
  return { ok: true, samples: results };
}
module.exports = { CAPTION_FPS, captionFrameNumbers, captionPixelError, verifyCaptionTrack };
