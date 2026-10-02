const { videoComposition, verifyVideoComposition } = require('../src/video-composition');
const { validateEditorial } = require('../src/production-render');

const source = { qa: { width: 1920, height: 1080, durationSeconds: 20 } };
const spec = { id: 'demo', channel: 'x', fit: 'contain', trim: { start: 2, duration: 10 } };

test('one composition recipe keeps source trim, framing and poster in output time', () => {
  const composition = videoComposition({ ...spec, crop: { x: 100, y: 50, width: 1280, height: 720 }, zoom: 1.1, thumbnail: { at: 3 } }, source);
  expect(composition).toMatchObject({ start: 2, duration: 10, width: 1280, height: 720, fps: 30, thumbnailAt: 3 });
  expect(composition.sourceFilter).toContain('trim=start=2:duration=10,setpts=PTS-STARTPTS,fps=30,crop=1280:720:100:50');
  expect(composition.sourceFilter).toContain('force_original_aspect_ratio=decrease');
});

test.each([
  { trim: { start: 19, duration: 2 } },
  { crop: { x: 1800, y: 0, width: 200, height: 100 } },
  { crop: { x: 0, y: 0, width: 100, height: 100 }, zoom: { scale: 2, x: 60 } },
  { zoom: 10000 },
  { thumbnail: { at: 10 } },
  { fit: 'stretch' },
])('unavailable composition is rejected before encoding: %j', (edit) => {
  expect(() => videoComposition({ ...spec, ...edit }, source)).toThrow();
});

test('invalid saved or configured presentation fails even without captions', () => {
  for (const edit of [{ crop: { x: -1, y: 0, width: 100, height: 100 } }, { zoom: 0 }, { thumbnail: { at: -1 } }]) {
    expect(() => validateEditorial({ ...spec, ...edit, captions: [] })).toThrow();
  }
  expect(() => videoComposition(spec, { qa: { durationSeconds: NaN } })).toThrow('measured duration');
});

test('a truncated output cannot pass merely because its codec and size are correct', () => {
  const composition = videoComposition(spec, source);
  const qa = { ok: true, codec: 'h264', pixelFormat: 'yuv420p', width: 1280, height: 720, durationSeconds: 10 };
  expect(() => verifyVideoComposition(qa, composition)).not.toThrow();
  expect(() => verifyVideoComposition({ ...qa, durationSeconds: 3 }, composition)).toThrow('edited duration');
  expect(() => verifyVideoComposition({ ...qa, ok: false }, composition)).toThrow('channel QA');
});
