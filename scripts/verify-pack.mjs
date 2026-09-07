import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

assert.equal(pkg.name, "take-a-repo", "npm package name must be take-a-repo");
assert.deepEqual(
  pkg.bin,
  { "take-a-repo": "bin/take-a-repo.js" },
  "take-a-repo must be the only published CLI",
);
assert.ok(Array.isArray(pkg.files), "package files allowlist is required");

const requiredFiles = [
  "package.json",
  "README.md",
  "README.ko.md",
  "LICENSE",
  "src/index.js",
  "bin/take-a-repo.js",
  "calibrator/index.html",
  "calibrator/styles.css",
  "calibrator/app.js",
  "calibrator/model.js",
  "calibrator/preview.js",
  "calibrator/regions.js",
  "campaign/index.html",
  "campaign/styles.css",
  "campaign/app.js",
  "skills/capture/SKILL.md",
  "skills/demo/SKILL.md",
  "skills/launch-proof/SKILL.md",
  "examples/evidence/collect.js",
  "examples/evidence/service.js",
  "examples/evidence/take-a-repo.config.js",
  "docs/evidence.md",
  "schemas/evidence.schema.json",
  "docs/handoff-conventions.md",
  "schemas/take-a-repo-manifest.schema.json",
  "schemas/storyboard.schema.json",
  "schemas/captions.schema.json",
  "schemas/calibration.schema.json",
  "schemas/approval.schema.json",
];

for (const relpath of requiredFiles) {
  assert.ok(existsSync(join(root.pathname, relpath)), `required package source is missing: ${relpath}`);
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
});
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.stderr.write(packed.stdout);
  process.exit(packed.status ?? 1);
}

const [manifest] = JSON.parse(packed.stdout);
assert.equal(manifest.name, "take-a-repo", "pack output must use the unscoped take-a-repo name");
const packedPaths = new Set(manifest.files.map((file) => file.path));
for (const relpath of requiredFiles) {
  assert.ok(packedPaths.has(relpath), `npm pack output is missing ${relpath}`);
}

for (const packedPath of packedPaths) {
  assert.ok(
    /^(package\.json|README\.md|README\.ko\.md|LICENSE|src\/|bin\/|calibrator\/|campaign\/|skills\/capture\/|skills\/demo\/|skills\/launch-proof\/|examples\/evidence\/|docs\/(handoff-conventions|evidence)\.md|schemas\/)/.test(packedPath),
    `unexpected file in npm pack output: ${packedPath}`,
  );
}

console.log(`package surface looks good (${manifest.entryCount} packed files).`);
