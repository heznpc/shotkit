const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJson } = require('./handoff-files');

// Protect the legacy in-place output directory. A failed/interrupted capture
// invalidates its published snapshot even when old manifests still exist.
async function withRunSession(outDir, run) {
  fs.mkdirSync(outDir, { recursive: true });
  const lock = path.join(outDir, '.take-a-repo.lock');
  const marker = path.join(outDir, '.take-a-repo-run.json');
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id }), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`capture output is locked: ${lock}. Check the owning process before removing a stale lock.`, { cause: error });
  }
  const startedAt = new Date().toISOString();
  try {
    writeJson(marker, { id, pid: process.pid, startedAt, status: 'running' });
    const result = await run();
    writeJson(marker, { id, startedAt, finishedAt: new Date().toISOString(), status: 'completed' });
    return result;
  } catch (error) {
    writeJson(marker, { id, startedAt, finishedAt: new Date().toISOString(), status: 'failed', error: error.message });
    throw error;
  } finally {
    fs.unlinkSync(lock);
  }
}

module.exports = { withRunSession };
