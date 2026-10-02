const fs = require('fs');
const os = require('os');
const path = require('path');
const { newProject, saveProject, readProject, applyProject, editProject } = require('../src/production-project');
const { renderKey } = require('../src/production-cache');

let outDir;
const configuredVideo = () => ({
  id: 'demo', kind: 'video', source: 'capture:video', channel: 'x', fit: 'contain', claims: ['works'],
  trim: { start: 0, duration: 10 }, crop: { x: 0, y: 0, width: 1280, height: 720 }, zoom: 1.04,
  thumbnail: { at: 1 }, captions: [{ id: 'result', start: 0, end: 3, text: 'Visible product result' }],
  captionOptions: { mode: 'focus', bottomOffset: 80, typography: {
    locale: 'en', minFontSize: 24, maxFontSize: 64, fonts: [{ family: 'Demo', from: 'fonts/demo.woff2' }],
  } },
});
const config = () => ({ evidence: {
  version: 1, producers: [{ id: 'capture', kind: 'cli', command: ['capture'] }],
  claims: [{ id: 'works', text: 'Visible result', checks: ['capture:result'] }],
  deliverables: [configuredVideo()],
} });
const patch = (baseRevision, operation) => ({ baseRevision, operations: [{ deliverable: 'demo', ...operation }] });

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-a-repo-project-edit-'));
  saveProject(outDir, newProject());
});
afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

test('saved framing and partial typography changes retain source identity and inherited fonts', () => {
  const spec = config();
  editProject(spec, outDir, patch(1, { set: {
    crop: { x: 50, y: 20, width: 900, height: 600 }, zoom: { scale: 1.1, x: '(iw-iw/1.1)/2', y: 0 },
    thumbnail: { at: 2 }, captionOptions: { typography: { minFontSize: 28 } },
  } }));
  const project = editProject(spec, outDir, patch(2, { set: { captionOptions: { bottomOffset: 120, typography: { maxLines: 3 } } } }));
  const effective = applyProject(spec, readProject(outDir())).evidence.deliverables[0];
  expect(project.revision).toBe(3);
  expect(effective).toMatchObject({
    source: 'capture:video', claims: ['works'], crop: { x: 50, y: 20, width: 900, height: 600 },
    zoom: { scale: 1.1, x: '(iw-iw/1.1)/2', y: 0 }, thumbnail: { at: 2 },
    captionOptions: { mode: 'focus', bottomOffset: 120, typography: {
      locale: 'en', minFontSize: 28, maxFontSize: 64, maxLines: 3, fonts: [{ family: 'Demo', from: 'fonts/demo.woff2' }],
    } },
  });
  expect(spec.evidence.deliverables[0]).toEqual(configuredVideo());
  const report = { producers: [], claims: [] };
  expect(renderKey(effective, report, 'engine')).not.toBe(renderKey(configuredVideo(), report, 'engine'));
});

test('font arrays replace while style keys remain merged', () => {
  const spec = config();
  const project = editProject(spec, outDir, patch(1, { set: { captionOptions: { typography: {
    fonts: [{ family: 'Updated', from: 'fonts/updated.woff2' }],
  } } } }));
  expect(applyProject(spec, project).evidence.deliverables[0].captionOptions.typography).toEqual({
    locale: 'en', minFontSize: 24, maxFontSize: 64, fonts: [{ family: 'Updated', from: 'fonts/updated.woff2' }],
  });
});

test('unset restores selected config defaults without discarding other saved edits', () => {
  const spec = config();
  editProject(spec, outDir, patch(1, { set: {
    zoom: 1.2, thumbnail: { at: 2 }, captionOptions: { bottomOffset: 100, typography: { minFontSize: 32, maxLines: 3 } },
  } }));
  const project = editProject(spec, outDir, patch(2, {
    unset: ['zoom', 'captionOptions.typography.minFontSize'], set: { thumbnail: { at: 3 } },
  }));
  expect(project.edits.demo.zoom).toBeUndefined();
  expect(project.edits.demo.captionOptions.typography).toEqual({ maxLines: 3 });
  expect(applyProject(spec, project).evidence.deliverables[0]).toMatchObject({
    zoom: 1.04, thumbnail: { at: 3 }, captionOptions: { bottomOffset: 100, typography: { minFontSize: 24, maxLines: 3 } },
  });
  const unchanged = editProject(spec, outDir, patch(3, { unset: ['zoom'] }));
  expect(unchanged.revision).toBe(3);
  const reset = editProject(spec, outDir, patch(3, { reset: true }));
  expect(reset.edits).toEqual({});
  expect(applyProject(spec, reset).evidence.deliverables[0]).toEqual(configuredVideo());
});

test('null disables configured framing; unsetting the override restores it', () => {
  const spec = config();
  const cleared = editProject(spec, outDir, patch(1, { set: { trim: null, crop: null, zoom: null, thumbnail: null } }));
  expect(applyProject(spec, cleared).evidence.deliverables[0]).toMatchObject({ trim: null, crop: null, zoom: null, thumbnail: null });
  const restored = editProject(spec, outDir, patch(2, { unset: ['trim', 'crop', 'zoom', 'thumbnail'] }));
  expect(restored.edits).toEqual({});
  expect(applyProject(spec, restored).evidence.deliverables[0]).toEqual(configuredVideo());
});

test.each([
  { set: { crop: { x: -1, y: 0, width: 100, height: 100 } } },
  { set: { crop: { x: 0, y: 0, width: 100.5, height: 100 } } },
  { set: { zoom: { scale: 1.2, anchor: 'center' } } },
  { set: { zoom: 1 } },
  { set: { thumbnail: { at: -1 } } },
  { set: { captionOptions: { typography: { maxLines: 4 } } } },
  { set: { captionOptions: { typography: { fonts: [{ family: 'Demo', from: 'demo.woff2', source: 'remote' }] } } } },
  { unset: ['source'] },
  { unset: ['captionOptions.typography.__proto__'] },
  { unset: ['zoom', 'zoom'] },
  { unset: [] },
  { reset: false, set: { zoom: 1.1 } },
  { reset: true, unset: ['zoom'] },
  { set: { captionOptions: { typography: { minFontSize: 30 } } }, unset: ['captionOptions'] },
])('invalid or conflicting edits preserve the current revision (%j)', (operation) => {
  expect(() => editProject(config(), outDir, patch(1, operation))).toThrow();
  expect(readProject(outDir())).toMatchObject({ revision: 1, edits: {} });
});
