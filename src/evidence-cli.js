const fs = require('fs');
const path = require('path');
const { evidenceState } = require('./evidence-state');
const { startEvidenceReview } = require('./evidence-review');

function inspectRepo(cwd) {
  const has = (file) => fs.existsSync(path.join(cwd, file));
  const entries = fs.readdirSync(cwd);
  const surfaces = [];
  if (has('package.json')) surfaces.push('node');
  if (has('Package.swift') || entries.some((f) => /\.(xcodeproj|xcworkspace)$/.test(f))) surfaces.push('native-apple');
  if (has('Cargo.toml')) surfaces.push('rust');
  if (has('pyproject.toml') || has('requirements.txt')) surfaces.push('python');
  if (has('go.mod')) surfaces.push('go');
  return {
    ok: true, path: cwd, configured: has('take-a-repo.config.js'), detected: surfaces,
    capabilities: ['browser-capture', 'command-producer', 'import-evidence', 'feature-checks', 'proof-page', 'channel-video', 'digest-bound-review'],
    next: has('take-a-repo.config.js') ? 'Read the committed config, then run take-a-repo <path> --json.' : 'Read docs/evidence.md; declare the product claims and existing producer commands in take-a-repo.config.js. Inspection does not execute repository code.',
  };
}

async function runEvidenceCommand(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const jsonMode = argv.includes('--json');
  try {
    const args = argv.slice(1).filter((arg) => arg !== '--json');
    if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) throw new Error(`usage: take-a-repo ${argv[0]} [path] [--json]`);
    const cwd = path.resolve((io.processCwd || (() => process.cwd()))(), args[0] || '.');
    let result;
    if (argv[0] === 'inspect') result = inspectRepo(cwd);
    else if (argv[0] === 'status') result = { ok: true, ...evidenceState(cwd) };
    else {
      const review = await startEvidenceReview({ outDir: cwd });
      result = { ok: true, status: 'review', url: review.url };
    }
    stdout.write(`${jsonMode ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    (jsonMode ? stdout : stderr).write(`${JSON.stringify({ ok: false, error: error.message, code: 1 })}\n`);
    return 1;
  }
}

module.exports = { runEvidenceCommand, inspectRepo };
