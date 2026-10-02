const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeAssetPath, sha256File, writeJson } = require('../src/handoff-files');
const { fingerprintInputs } = require('../src/evidence-inputs');
const { validateEvidenceConfig } = require('../src/evidence-contract');
const { resolveChannelProfile } = require('../src/channels');
const { reviewStatus } = require('../src/production-review');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-hardening-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const config = () => ({ evidence: { version: 1,
  producers: [{ id: 'capture', kind: 'cli', command: ['collect'] }],
  claims: [{ id: 'result', text: 'Visible result', checks: ['capture:result'] }],
  deliverables: [{ id: 'demo', kind: 'video', source: 'capture:video', channel: 'x', fit: 'contain', claims: ['result'] }],
} });

test('new output files below an escaping or dangling symlink fail containment', () => {
  const output = path.join(root, 'output'); fs.mkdirSync(output);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(output, 'linked'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(output, 'dangling'));
  expect(safeAssetPath(output, { outPath: 'linked/new/file.png' })).toBeNull();
  expect(safeAssetPath(output, { outPath: 'dangling/new.png' })).toBeNull();
  expect(safeAssetPath(output, { outPath: '..notes/file.png' })).toBe(path.join(output, '..notes/file.png'));
});

test('local input declarations cannot bypass symlink policy with a nested filename', () => {
  fs.mkdirSync(path.join(root, 'source'));
  fs.writeFileSync(path.join(root, 'source/video.mp4'), 'fixture');
  fs.symlinkSync(path.join(root, 'source'), path.join(root, 'linked'));
  expect(() => fingerprintInputs(root, ['linked/video.mp4'])).toThrow('symlink');
  expect(fingerprintInputs(root, ['source/video.mp4']).files).toEqual([
    ['source/video.mp4', sha256File(path.join(root, 'source/video.mp4'))],
  ]);
});

test('input fingerprinting streams file bytes without reading entire source videos', () => {
  fs.writeFileSync(path.join(root, 'video.mp4'), Buffer.alloc(200000, 7));
  const read = jest.spyOn(fs, 'readFileSync');
  try {
    expect(fingerprintInputs(root, ['video.mp4']).files).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

test.each(['capture:video:ignored', 'missing:video', 'capture:', 123])('invalid source reference fails before a producer starts: %s', (source) => {
  const value = config(); value.evidence.deliverables[0].source = source;
  expect(() => validateEvidenceConfig(value)).toThrow();
});

test('generated poster and timeline IDs cannot collide with another deliverable', () => {
  const value = config(); value.evidence.deliverables.push({ id: 'demo-poster', kind: 'proof', claims: ['result'] });
  expect(() => validateEvidenceConfig(value)).toThrow('asset id collision');
});

test.each(['__proto__', 'constructor', 'toString', ['x']])('inherited properties are not channels: %s', (channel) => {
  expect(() => resolveChannelProfile(channel)).toThrow('unknown channel');
});

test('damaged editorial review shapes return pending instead of crashing status or passing', () => {
  const report = { editorialReviewRequired: true, deliverables: [{ id: 'demo', kind: 'video' }] };
  for (const deliverables of [{ length: 1 }, [null], [{ id: 'demo', checks: { length: 5 } }], [{ id: 'demo', checks: [null, null, null, null, null] }]]) {
    writeJson(path.join(root, 'editorial-review.json'), { reviewDigest: 'digest', deliverables });
    expect(reviewStatus(report, root, 'digest').status).toBe('pending');
  }
});
