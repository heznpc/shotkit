const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Ajv = require('ajv');
const { digest, validateEvidenceConfig } = require('./evidence-contract');
const { writeJson, sha256File } = require('./handoff-files');
const { validateEditorial } = require('./production-render');
const { EDIT_FIELDS, EDIT_PATHS } = require('./editorial');

const PROJECT_FILE = 'take-a-repo-project.json';
const projectSchema = require('../schemas/production-project.schema.json');
const validate = new Ajv({ allErrors: true }).compile(projectSchema);
const editablePaths = new Set(EDIT_PATHS);

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

// Arrays and complete framing rectangles replace; style and typography keys
// merge so a size adjustment cannot silently drop the declared locale/fonts.
function mergeEdit(base, edit) {
  const merged = { ...base, ...edit };
  if (isObject(edit?.captionOptions)) {
    merged.captionOptions = { ...base?.captionOptions, ...edit.captionOptions };
    if (isObject(edit.captionOptions.typography)) {
      merged.captionOptions.typography = { ...base?.captionOptions?.typography, ...edit.captionOptions.typography };
    }
  }
  return merged;
}

function assignedPaths(set) {
  return Object.keys(set || {}).flatMap((key) => {
    if (key !== 'captionOptions' || !isObject(set[key])) return [key];
    return Object.keys(set[key]).flatMap((style) => style === 'typography' && isObject(set[key][style])
      ? Object.keys(set[key][style]).map((field) => `${key}.${style}.${field}`)
      : [`${key}.${style}`]);
  });
}

function unsetEdit(edit, field) {
  const keys = field.split('.');
  let target = edit;
  const parents = [];
  for (const key of keys.slice(0, -1)) {
    if (!isObject(target[key])) return;
    parents.push([target, key]);
    target = target[key];
  }
  delete target[keys.at(-1)];
  for (const [parent, key] of parents.reverse()) {
    if (!Object.keys(parent[key]).length) delete parent[key];
  }
}

function validateProject(project) {
  if (!validate(project)) throw new Error(`invalid production project: ${validate.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
  return project;
}

function readProject(outDir) {
  const file = path.join(outDir, PROJECT_FILE);
  return fs.existsSync(file) ? validateProject(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
}

function newProject() {
  const now = new Date().toISOString();
  return { version: 1, kind: 'take-a-repo.production-project', id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now, edits: {} };
}

function saveProject(outDir, project) {
  validateProject(project);
  const history = path.join(outDir, 'project-history', project.id);
  fs.mkdirSync(history, { recursive: true });
  // History is append-only. The current pointer is replaced only after the
  // complete revision exists, so an interrupted edit cannot corrupt history.
  fs.writeFileSync(path.join(history, `${project.revision}.json`), `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
  writeJson(path.join(outDir, PROJECT_FILE), project);
  return project;
}

function projectReference(outDir, project) {
  return { path: PROJECT_FILE, id: project.id, revision: project.revision, sha256: sha256File(path.join(outDir, PROJECT_FILE)) };
}

function applyProject(config, project) {
  validateEvidenceConfig(config);
  validateProject(project);
  const videos = new Set(config.evidence.deliverables.filter((d) => d.kind === 'video').map((d) => d.id));
  for (const id of Object.keys(project.edits)) if (!videos.has(id)) throw new Error(`project edit references missing video ${id}; reconcile the project before running`);
  return {
    ...config,
    evidence: {
      ...config.evidence,
      deliverables: config.evidence.deliverables.map((d) => {
        const edit = project.edits[d.id];
        return mergeEdit(d, edit);
      }),
    },
  };
}

function editProject(config, outDir, patch) {
  const previous = readProject(outDir);
  if (!previous) throw new Error('no production project; run production run first');
  if (!isObject(patch) || Object.keys(patch).some((k) => !['baseRevision', 'operations'].includes(k))
    || patch.baseRevision !== previous.revision) throw new Error('project revision conflict; read the current project and rebase the edit');
  if (!Array.isArray(patch.operations) || !patch.operations.length || patch.operations.length > 100) throw new Error('edit requires 1..100 operations');
  const project = JSON.parse(JSON.stringify(previous));
  for (const op of patch.operations) {
    if (!isObject(op) || Object.keys(op).some((k) => !['deliverable', 'set', 'unset', 'reset'].includes(k))) throw new Error('invalid edit operation');
    const configured = config.evidence.deliverables.some((d) => d.kind === 'video' && d.id === op.deliverable);
    const staleReset = op.reset === true && Object.hasOwn(project.edits, op.deliverable);
    if (!configured && !staleReset) throw new Error('edit requires a configured video deliverable or reset of a saved edit');
    const hasSet = Object.hasOwn(op, 'set');
    const hasUnset = Object.hasOwn(op, 'unset');
    if (Object.hasOwn(op, 'reset') && op.reset !== true
      || op.reset === true && (hasSet || hasUnset)
      || op.reset !== true && !hasSet && !hasUnset) throw new Error('choose set/unset or reset for each edit');
    if (op.reset === true) delete project.edits[op.deliverable];
    else {
      if (hasSet && (!isObject(op.set) || !Object.keys(op.set).length
        || Object.keys(op.set).some((k) => !EDIT_FIELDS.includes(k)))) throw new Error('only editorial fields can be edited; sources, claims, checks and authority are protected');
      if (hasUnset && (!Array.isArray(op.unset) || !op.unset.length || op.unset.length > editablePaths.size
        || new Set(op.unset).size !== op.unset.length || op.unset.some((field) => !editablePaths.has(field)))) {
        throw new Error('unset requires unique editable field paths; sources, claims, checks and authority are protected');
      }
      const paths = assignedPaths(op.set);
      if (op.unset?.some((field) => paths.some((assigned) => assigned === field || assigned.startsWith(`${field}.`) || field.startsWith(`${assigned}.`)))) {
        throw new Error('set and unset cannot overlap within one edit operation');
      }
      const edit = mergeEdit(project.edits[op.deliverable], op.set);
      for (const field of op.unset || []) unsetEdit(edit, field);
      if (Object.keys(edit).length) project.edits[op.deliverable] = edit;
      else delete project.edits[op.deliverable];
    }
  }
  const effective = applyProject(config, project);
  for (const spec of effective.evidence.deliverables) if (spec.kind === 'video') validateEditorial(spec);
  if (digest(JSON.stringify(previous.edits)) === digest(JSON.stringify(project.edits))) return previous;
  project.revision++;
  // A crash after writing history but before replacing the current pointer can
  // leave an uncommitted revision. Preserve it and allocate the next free one.
  while (fs.existsSync(path.join(outDir, 'project-history', project.id, `${project.revision}.json`))) project.revision++;
  project.updatedAt = new Date().toISOString();
  return saveProject(outDir, project);
}

async function withProjectLock(outDir, action) {
  fs.mkdirSync(outDir, { recursive: true });
  const lock = path.join(outDir, '.take-a-repo-project.lock');
  const token = crypto.randomUUID();
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('production project is locked; check the owning process', { cause: error });
    throw error;
  }
  try { return await action(token); } finally { fs.unlinkSync(lock); }
}

module.exports = { PROJECT_FILE, readProject, newProject, saveProject, projectReference, applyProject, editProject, withProjectLock };
