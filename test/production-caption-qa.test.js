const { captionFrameNumbers, captionPixelError } = require('../src/production-caption-qa');
const { validateEditorial } = require('../src/production-render');

test('caption samples stay within start-inclusive, end-exclusive output frame intervals', () => {
  expect(captionFrameNumbers([
    { id: 'short', start: 0.2, end: 0.8 },
    { id: 'one-frame', start: 1, end: 1 + 1 / 30 },
    { id: 'fractional', start: 2.01, end: 2.04 },
  ])).toEqual([15, 30, 61]);
  expect(() => validateEditorial({ id: 'demo', captions: [{ id: 'invisible', start: 0.01, end: 0.02, text: 'No output frame' }] })).toThrow(/no output frame/);
});

test('pixel QA measures glyphs even when the missing caption is a tiny fraction of the band', () => {
  const expected = { width: 100, height: 10, data: Buffer.alloc(100 * 10 * 4, 20) };
  expected.data.set([255, 255, 255, 255], 200);
  const absent = Buffer.alloc(100 * 10 * 3, 20);
  const present = Buffer.from(absent);
  present.set([250, 251, 249], 150);
  expect(captionPixelError(expected, present)).toBeLessThan(10);
  expect(captionPixelError(expected, absent)).toBeGreaterThan(200);
  expect(() => captionPixelError(expected, Buffer.alloc(0))).toThrow(/missing or incomplete/);
  expected.data.fill(20);
  expect(() => captionPixelError(expected, absent)).toThrow(/no visible text/);
});

test('pixel QA checks alpha-composited entrances and detects captions left behind after exit', () => {
  const base = Buffer.from([20, 40, 60]);
  const mask = { width: 1, height: 1, data: Buffer.from([255, 255, 255, 255]) };
  const halfway = { width: 1, height: 1, data: Buffer.from([220, 200, 180, 128]) };
  expect(captionPixelError(halfway, Buffer.from([120, 120, 120]), { base, mask })).toBeLessThan(1);
  expect(captionPixelError(halfway, base, { base, mask })).toBeGreaterThan(70);
  const hidden = { width: 1, height: 1, data: Buffer.alloc(4) };
  expect(captionPixelError(hidden, base, { base, mask })).toBe(0);
  expect(captionPixelError(hidden, Buffer.from([220, 200, 180]), { base, mask })).toBeGreaterThan(100);
});

test('a large matching caption panel cannot conceal a missing glyph', () => {
  const expected = { width: 100, height: 1, data: Buffer.alloc(400) };
  const mask = { width: 100, height: 1, data: Buffer.alloc(400) };
  const base = Buffer.alloc(300, 20), actual = Buffer.alloc(300);
  for (let pixel = 0; pixel < 100; pixel++) {
    expected.data.set([13, 17, 23, 224], pixel * 4);
    actual.set([14, 17, 23], pixel * 3);
  }
  expected.data.set([255, 255, 255, 255], 200);
  mask.data.set([255, 255, 255, 255], 200);
  expect(captionPixelError(expected, actual, { base, mask })).toBeGreaterThan(200);
});

test('caption motion samples include both sides of a transition and deduplicate single-frame states', () => {
  const { captionSampleFrames } = require('../src/production-captions');
  expect(captionSampleFrames(30, 90, 37)).toEqual([30, 35, 37, 89]);
  expect(captionSampleFrames(30, 31, 37)).toEqual([30]);
  expect(captionSampleFrames(30, 30, 37)).toEqual([]);
  expect(captionSampleFrames(30, 90, 20)).toEqual([30, 89]);
});

test('caption scratch cleanup preserves portable edits and source/final assets', () => {
  const fs = require('fs');
  const path = require('path');
  const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'caption-cleanup-'));
  const { cleanupCaptionTrack } = require('../src/production-captions');
  try {
    for (const name of ['blank.png', 'frame-00001.png', 'mask-00002.png', 'track.ffconcat', 'timeline.json', 'source.mp4', 'final.mp4']) {
      fs.writeFileSync(path.join(directory, name), 'preserve non-scratch');
    }
    cleanupCaptionTrack(directory);
    expect(fs.readdirSync(directory).sort()).toEqual(['final.mp4', 'source.mp4', 'timeline.json']);
    cleanupCaptionTrack(directory);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('production inherits Shorts focus and rejects unreadable intervals and unknown style fields', () => {
  const { resolvedCaptionOptions } = require('../src/production-render');
  expect(resolvedCaptionOptions({ channel: 'youtube-shorts' })).toMatchObject({ mode: 'focus', appearance: 'outline', wordsPerChunk: 3, bottomOffset: 380 });
  expect(() => validateEditorial({ id: 'demo', channel: 'youtube-shorts', captions: [{ id: 'blink', start: 0, end: 1 / 30, text: 'Read these seven words before they disappear' }] })).toThrow('dense-caption');
  expect(() => validateEditorial({ id: 'demo', captionOptions: { mode: 'wrong' } })).toThrow();
  expect(() => validateEditorial({ id: 'demo', captionOptions: { activeColour: 'red' } })).toThrow('unsupported');
});

test.each([false, 0, 'focus'])('invalid editorial containers fail instead of silently clearing captions (%p)', (value) => {
  expect(() => validateEditorial({ id: 'demo', captions: value })).toThrow('captions must be an array');
  expect(() => validateEditorial({ id: 'demo', captionOptions: value })).toThrow('captionOptions must be an object');
});

test('editorial validation rejects a phrase edit that loses words before rendering', () => {
  const spec = { id: 'demo', channel: 'youtube-shorts', captions: [{ id: 'intro', start: 0, end: 4, text: 'Keep original footage', focusChunks: ['Keep original footage'] }] };
  expect(() => validateEditorial(spec)).not.toThrow();
  spec.captions[0].focusChunks = ['Keep original'];
  expect(() => validateEditorial(spec)).toThrow(/focusChunks/);
});

describe('streamed final-video caption QA', () => {
  const { EventEmitter, once } = require('events');
  const { PassThrough } = require('stream');
  const fs = require('fs');
  const path = require('path');
  const { PNG } = require('pngjs');
  let directory;

  beforeEach(() => { directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'caption-stream-')); });
  afterEach(() => {
    jest.dontMock('child_process');
    jest.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function childFor(chunks, { code = 0, hang = false } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough({ highWaterMark: 3 });
    child.stderr = new PassThrough();
    let closed = false;
    const close = (exitCode, signal = null) => {
      if (closed) return;
      closed = true;
      child.emit('close', exitCode, signal);
    };
    child.kill = jest.fn(() => {
      child.stdout.destroy();
      queueMicrotask(() => close(null, 'SIGKILL'));
      return true;
    });
    child.stdout.once('end', () => queueMicrotask(() => close(code)));
    if (!hang) queueMicrotask(async () => {
      try {
        for (const chunk of chunks) {
          if (!child.stdout.write(Buffer.from(chunk))) await once(child.stdout, 'drain');
        }
        child.stdout.end();
      } catch (_error) { close(code || 1); }
    });
    return child;
  }

  function verifier(spawnMock) {
    let verify;
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: spawnMock }));
      verify = require('../src/production-caption-qa').verifyCaptionTrack;
    });
    jest.dontMock('child_process');
    return verify;
  }

  function reference(rgba = [200, 200, 200, 128]) {
    const file = path.join(directory, 'overlay.png');
    const png = new PNG({ width: 1, height: 1 });
    png.data.set(rgba);
    fs.writeFileSync(file, PNG.sync.write(png));
    const mask = new PNG({ width: 1, height: 1 });
    mask.data.set([255, 255, 255, 255]);
    fs.writeFileSync(path.join(directory, 'mask.png'), PNG.sync.write(mask));
    return file;
  }

  test('decodes each input once, pairs frame indices and reuses duplicate samples', async () => {
    const file = reference();
    const maskFile = path.join(directory, 'mask.png');
    // Deliberately split raw frames at arbitrary byte boundaries.
    const spawnMock = jest.fn()
      .mockImplementationOnce(() => childFor([[105], [110, 115, 135], [140, 145]]))
      .mockImplementationOnce(() => childFor([[10, 20], [30], [70, 80, 90]]));
    const verify = verifier(spawnMock);
    const result = await verify({ bin: 'mock-ffmpeg', video: 'final.mp4', sourceVideo: 'source.mp4', sourceFilter: 'fps=30', width: 1, height: 1,
      samples: [{ id: 'later', frame: 3, file, maskFile }, { id: 'first', frame: 1, file, maskFile }, { id: 'same-frame', frame: 1, file, maskFile }] });
    expect(result.samples.map(({ id, frame }) => ({ id, frame }))).toEqual([
      { id: 'first', frame: 1 }, { id: 'same-frame', frame: 1 }, { id: 'later', frame: 3 },
    ]);
    expect(result.samples.every((sample) => sample.meanPixelError < 1)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const [, args] of spawnMock.mock.calls) {
      expect(args[args.indexOf('-frames:v') + 1]).toBe('2');
      expect(args[args.indexOf('-vf') + 1]).toContain("select='eq(n,1)+eq(n,3)'");
    }
  });

  test('rejects a decoder that emits enough pixels but exits unsuccessfully', async () => {
    const verify = verifier(jest.fn(() => childFor([[200, 200, 200]], { code: 1 })));
    await expect(verify({ bin: 'mock-ffmpeg', video: 'final.mp4', width: 1, height: 1,
      samples: [{ id: 'word', frame: 0, file: reference([200, 200, 200, 255]) }] })).rejects.toThrow('decoder failed');
  });

  test('rejects partial frames and terminates the other decoder', async () => {
    const output = childFor([[200, 200]]);
    const source = childFor([], { hang: true });
    const verify = verifier(jest.fn().mockReturnValueOnce(output).mockReturnValueOnce(source));
    await expect(verify({ bin: 'mock-ffmpeg', video: 'final.mp4', sourceVideo: 'source.mp4', sourceFilter: 'fps=30', width: 1, height: 1,
      samples: [{ id: 'word', frame: 0, file: reference() }] })).rejects.toThrow('could not decode');
    expect(source.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('times out a stalled decoder and closes it', async () => {
    jest.useFakeTimers();
    const stalled = childFor([], { hang: true });
    const verify = verifier(jest.fn(() => stalled));
    const promise = verify({ bin: 'mock-ffmpeg', video: 'final.mp4', width: 1, height: 1,
      samples: [{ id: 'word', frame: 0, file: reference() }] });
    const rejection = expect(promise).rejects.toThrow('timed out');
    await jest.runOnlyPendingTimersAsync();
    await rejection;
    expect(stalled.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
