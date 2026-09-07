const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { capture } = require('../src/capture');
const { evidenceState } = require('../src/evidence-state');
const { startEvidenceReview } = require('../src/evidence-review');
const { readEvidence, measureAsset } = require('../src/evidence-contract');
const { inspectRepo } = require('../src/evidence-cli');
const { withRunSession } = require('../src/run-session');
const { approvalGate, emptyApprovalDocument } = require('../src/approval');
const { sha256File } = require('../src/handoff-files');

const collector = path.resolve(__dirname, '../examples/evidence/collect.js');
let cwd;
function config() {
  return {
    outDir: 'evidence',
    evidence: {
      version: 1,
      producers: [{ id: 'cli', kind: 'cli', command: [process.execPath, collector, 'cli'] }, { id: 'api', kind: 'api', command: [process.execPath, collector, 'api'] }],
      claims: [{ id: 'conversion', text: 'CLI and API convert correctly', checks: ['cli:converts', 'api:converts'] }],
      deliverables: [{ id: 'proof', kind: 'proof', claims: ['conversion'] }],
    },
  };
}
const run = (spec = config(), opts = {}) => capture(spec, { cwd, log: () => {}, ...opts });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-evidence-test-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

test('executes real CLI and API consumer checks without launching Chromium', async () => {
  const result = await run();
  expect(result).toMatchObject({ machineStatus: 'publish-ready', status: 'awaiting-approval', exitCode: 0 });
  const state = evidenceState(result.outDir);
  expect(state.publishable).toBe(false);
  expect(state.report.claims[0].status).toBe('verified');
  expect(state.report.producers.map((p) => p.kind)).toEqual(['cli', 'api']);
  const api = JSON.parse(fs.readFileSync(path.join(state.runDir, 'raw/api/observations.json')));
  expect(api.map((r) => r.status)).toEqual([200, 404, 400]);
  expect(fs.readFileSync(path.join(state.runDir, 'deliverables/proof.html'), 'utf8')).toContain('CLI and API convert correctly');
});

test('a failed command writes a new failed candidate without overwriting previous evidence', async () => {
  const first = await run();
  const bytes = fs.readFileSync(first.manifest);
  const spec = config();
  spec.evidence.producers[0].command = [process.execPath, '-e', 'process.exit(7)'];
  const second = await run(spec);
  expect(second.exitCode).toBe(1);
  expect(second.manifest).not.toBe(first.manifest);
  expect(fs.readFileSync(first.manifest)).toEqual(bytes);
  expect(evidenceState(second.outDir)).toMatchObject({ status: 'needs-fix', publishable: false });
});

test('enforces process timeout and blocks after the declared retry budget', async () => {
  const spec = config();
  spec.evidence.producers = [{ id: 'cli', kind: 'cli', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 30 }];
  spec.evidence.claims[0].checks = ['cli:converts'];
  const result = await run(spec, { attempt: 3 });
  expect(result.machineStatus).toBe('blocked');
  expect(evidenceState(result.outDir).report.producers[0].error).toContain('timed out');
});

test('unknown check and scoped producer runs cannot become whole-pack ready', async () => {
  const spec = config();
  spec.evidence.claims[0].checks = ['cli:nonexistent'];
  expect((await run(spec)).machineStatus).toBe('needs-fix');
  const partial = await run(config(), { scenes: ['cli'] });
  expect(evidenceState(partial.outDir)).toMatchObject({ publishable: false, scope: { full: false } });
});

test('native evidence imports are measured, snapshotted and never treated as executed checks', async () => {
  const input = path.join(cwd, 'native'); fs.mkdirSync(input);
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = i % 256; png.data[i + 1] = 80; png.data[i + 2] = 255; png.data[i + 3] = 255; }
  fs.writeFileSync(path.join(input, 'screen.png'), PNG.sync.write(png));
  write(path.join(input, 'evidence.json'), { version: 1, assets: [{ id: 'screen', path: 'screen.png', mediaType: 'image/png', role: 'screenshot' }], checks: [{ id: 'visible', status: 'pass', summary: 'Native screen', assets: ['screen'] }] });
  const spec = config();
  spec.evidence.producers = [{ id: 'native', kind: 'native', import: 'native/evidence.json' }];
  spec.evidence.claims[0].checks = ['native:visible'];
  const result = await run(spec);
  const state = evidenceState(result.outDir);
  expect(state.report.producers[0].mode).toBe('imported');
  expect(state.report.claims[0].status).toBe('unverified');
  expect(state.report.files.find((f) => f.mediaType === 'image/png').qa.nonBlank).toBe(true);
});

test('rejects traversal, symlink escapes, duplicate IDs and forged media metadata', () => {
  const file = path.join(cwd, 'evidence.json');
  const asset = { id: 'a', path: '../secret.txt', mediaType: 'text/plain', role: 'artifact' };
  write(file, { version: 1, assets: [asset], checks: [] });
  expect(() => readEvidence(file)).toThrow('contained');
  write(file, { version: 1, assets: [{ ...asset, path: 'a.txt' }, { ...asset, path: 'b.txt' }], checks: [] });
  expect(() => readEvidence(file)).toThrow('duplicate');
  fs.writeFileSync(path.join(cwd, 'fake.png'), 'not a png');
  expect(() => measureAsset(cwd, { path: 'fake.png', mediaType: 'image/png' })).toThrow('invalid/blank');
  fs.symlinkSync(__filename, path.join(cwd, 'escape.txt'));
  expect(() => measureAsset(cwd, { path: 'escape.txt', mediaType: 'text/plain' })).toThrow('unsafe');
});

test('review uses exact file set, saves targeted feedback and rejects stale candidates', async () => {
  const result = await run();
  const server = await startEvidenceReview({ outDir: result.outDir });
  try {
    const html = await fetch(server.url).then((r) => r.text());
    const token = html.match(/name="token" content="([^"]+)"/)[1];
    const candidate = evidenceState(result.outDir);
    const post = (body, headers = {}) => fetch(`${server.url}/api/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': token, ...headers }, body: JSON.stringify(body) });
    const decision = { reviewDigest: candidate.reviewDigest, status: 'approved', feedback: [] };
    expect((await post(decision, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await post(decision, { 'X-Review-Token': 'wrong' })).status).toBe(403);
    expect((await post({ ...decision, status: 'changes-requested', feedback: [{ deliverable: 'proof', note: 'Explain error behavior.' }] })).status).toBe(200);
    expect(evidenceState(result.outDir).feedback[0]).toMatchObject({ deliverable: 'proof', claims: ['conversion'] });
    expect((await post(decision)).status).toBe(200);
    expect(evidenceState(result.outDir).publishable).toBe(true);
    fs.writeFileSync(path.join(candidate.runDir, 'raw/api/observations.json'), 'changed');
    expect(evidenceState(result.outDir).publishable).toBe(false);
    expect((await post(decision)).status).toBe(409);
    expect((await fetch(`${server.url}/files/raw/api/observations.json`)).status).toBe(409);
    await run();
    expect(evidenceState(result.outDir).status).toBe('awaiting-approval');
    expect((await post(decision)).status).toBe(409);
  } finally { await server.close(); }
});

test('deletion and report mutation invalidate candidate readiness', async () => {
  const result = await run();
  const state = evidenceState(result.outDir);
  fs.unlinkSync(path.join(state.runDir, 'deliverables/proof.html'));
  expect(evidenceState(result.outDir).problems).toHaveLength(1);
  fs.appendFileSync(result.manifest, ' ');
  expect(() => evidenceState(result.outDir)).toThrow('report integrity mismatch');
});

test('legacy approvals rehash actual files, include posters and fail closed after interrupted capture', async () => {
  fs.writeFileSync(path.join(cwd, 'video.mp4'), 'test-video');
  fs.writeFileSync(path.join(cwd, 'poster.png'), 'test-poster');
  const manifest = { assets: ['video.mp4', 'poster.png'].map((file) => ({ id: file, outPath: file, integrity: { algorithm: 'sha256', digest: sha256File(path.join(cwd, file)) } })), handoff: { automation: { status: 'publish-ready', targets: [{ story: 'demo', target: 'x', status: 'publish-ready', deliverable: { id: 'video.mp4' }, thumbnail: { id: 'poster.png' } }] } } };
  const doc = emptyApprovalDocument();
  const gate = () => approvalGate(manifest, doc, { outDir: cwd });
  doc.decisions.demo = { x: { status: 'approved', assetDigest: gate().targets[0].assetDigest, decidedAt: new Date().toISOString() } };
  expect(gate().publishable).toBe(true);
  await expect(withRunSession(cwd, async () => { throw new Error('capture failed'); })).rejects.toThrow();
  expect(gate().publishable).toBe(false);
  await withRunSession(cwd, async () => {});
  expect(gate().publishable).toBe(true);
  fs.writeFileSync(path.join(cwd, 'poster.png'), 'unreviewed poster');
  expect(gate().publishable).toBe(false);
});

test('concurrent runs are rejected and inspection never executes config', async () => {
  await withRunSession(cwd, async () => {
    await expect(withRunSession(cwd, async () => {})).rejects.toThrow('locked');
  });
  fs.writeFileSync(path.join(cwd, 'take-a-repo.config.js'), 'throw new Error("must not run")');
  expect(inspectRepo(cwd).configured).toBe(true);
});

test('both lint switches remain visible at the machine contract boundary', () => {
  const { demoStoryboard } = require('../src/handoff/storyboard');
  for (const flags of [{ lint: false }, { storyboardLint: false }]) {
    expect(demoStoryboard({ name: 'example', ...flags }, { width: 1280, height: 720 }).lintEnabled).toBe(false);
  }
});
