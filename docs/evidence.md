# Product evidence contract

## Need → current implementation → completion checks

The completion handoff used to require a separate instruction to run the
product, capture it, explain its behavior and prepare review assets. Browser
rendering was also being confused with functional verification.

`config.evidence` now routes through the same `capture()` and CLI entrypoint as
legacy browser configs, without requiring Chromium for CLI/API/native producers.
It runs repo-owned tools, validates their files, resolves claims against checks,
renders a proof page or channel video, and opens a digest-bound local review.
The real CLI/API example and integration tests are in `examples/evidence` and
`test/evidence.test.js`. Platform automation itself remains the producer's job.

## Run the shipped non-web consumer

From a source checkout after `npm ci`:

```sh
node bin/take-a-repo.js inspect examples/evidence --json
node bin/take-a-repo.js examples/evidence --json
node bin/take-a-repo.js status examples/evidence/product-evidence --json
node bin/take-a-repo.js review examples/evidence/product-evidence --json
```

The example executes a CLI and an actual local HTTP API. It asserts conversion
results and invalid input/404 behavior, then links their recorded observations
from the proof page. No browser or ffmpeg is needed. `review` is a foreground
loopback server; terminate it after user review. There is no CLI approve command
and no uploader. Automated tests submit only synthetic fixture approvals.

On macOS, `examples/evidence/native/script/build_and_run.sh` compiles and launches
a real AppKit `.app`, invokes its button action and captures its live content
view using `NSView.cacheDisplay`. This is explicitly a **view snapshot**, not a
desktop-wide OS screenshot. It writes the same producer schema and checks both
conversion and invalid input. Its source and compiled bundle are local fixtures,
not a substitute for exercising your own shipped native app. No screen-recording
permission or unrelated application capture is needed.

## Consumer intent (one take-a-repo.config.js)

```js
module.exports = {
  outDir: 'product-evidence',
  // Optional committed build command; shell semantics match the browser path.
  build: 'npm run build',
  evidence: {
    version: 1,
    producers: [{
      id: 'api', kind: 'api',
      command: ['node', 'scripts/collect-evidence.js'],
      timeoutMs: 120000,
    }],
    claims: [{ id: 'created', text: 'Creates and retrieves a record', checks: ['api:roundtrip'] }],
    deliverables: [{ id: 'release-proof', kind: 'proof', claims: ['created'] }],
  },
};
```

`kind` is `browser`, `native`, `cli`, or `api`. This classifies the execution
surface; it does not silently select/download a third-party driver. Commands
are argv arrays, run without a shell, with the consumer checkout as cwd. They
have the same trust/permissions as a repo test script, **not a sandbox**. Review
unknown repositories before execution. Commands inherit the environment, and
their local logs can contain secrets. Producers must use fixtures or redact
sensitive data before declaring any artifact for delivery. Nothing is uploaded.

The engine sets `TAKE_A_REPO_OUTPUT_DIR` to a fresh per-producer directory. Write
`evidence.json` and its referenced files there. Do not write to previous runs.
The producer timeout defaults to two minutes, is bounded to one hour, and kills
the process group on Unix. Stdout/stderr are bounded to 1 MiB and saved locally;
they are not automatically added to delivery files. Exit failures and invalid
artifacts fail the candidate regardless of producer-supplied check statuses.

## Producer output

```json
{
  "version": 1,
  "assets": [{
    "id": "response", "path": "response.json",
    "mediaType": "application/json", "role": "request-response"
  }],
  "checks": [{
    "id": "roundtrip", "status": "pass",
    "summary": "POST returned 201; GET returned the submitted fields",
    "assets": ["response"]
  }]
}
```

The bundled `schemas/evidence.schema.json` is authoritative. Supported files:
PNG; MP4/WebM/MOV; UTF-8 JSON, plain text and Markdown. Roles describe evidence,
not filenames. Paths are relative, contained (including realpath/symlink checks),
and unique. The engine hashes the real bytes, parses PNG/JSON, fully decodes video
with ffmpeg and rejects blank screenshots. Producer-supplied QA metadata is not
accepted. JPEG/audio adapters are not implemented.

Checks are `pass`, `fail`, or `unverified`; every check references real assets.
Checks from an executed producer are explicitly labelled `producer-asserted`:
the engine verifies execution and artifacts, not the correctness of arbitrary
test logic. A claim is verified only when every referenced check passed in this
run. Missing checks, failed commands, and imported checks cannot verify a claim.
The report records git revision, dirty state, tracked diff/config digests, Node
and OS, execution times, and the build result. These identify the observed run;
they are not a reproducible-build certificate or signed supply-chain attestation.

## Browser, native and imported media

An existing browser config can be wrapped without rewriting its scenes:

```js
{ id: 'browser', kind: 'browser', capture: require('./browser-capture.config.js') }
```

This adapter exposes `browser:capture`, meaning the scene hooks executed, not
that arbitrary product features passed. Put actual assertions in those hooks.
It assigns `asset-0`, etc. in manifest order; for stable render-source IDs use a
command producer that writes the explicit producer schema.

A native producer runs the product's actual platform driver, exports screenshots
or recordings, and records checks. For example, use a repo-owned wrapper around
Maestro, Appium, fastlane or a Swift test runner as its `command`. There is no
built-in iOS/Android/macOS action DSL or platform-driver installer.

```js
{ id: 'desktop', kind: 'native', command: ['node', 'scripts/capture-desktop.js'] }
// Existing evidence, for inspection only until re-executed:
{ id: 'import', kind: 'native', import: 'fixtures/native/evidence.json' }
```

Imports must be in the consumer checkout. Files are copied into the run and
measured, but all imported checks become `unverified`. A passed field in an
imported JSON file is not evidence of an execution in this run.

## Deliverables and review

`kind:'proof'` creates a static HTML page containing claim/check status, measured
screenshots/video and links to raw observations. It does not fabricate a UI for
nonvisual products. A video recipe uses an actual recorded source:

```js
{ id: 'desktop-x', kind: 'video', source: 'desktop:recording', channel: 'x',
  fit: 'contain', trim: { start: 0, duration: 30 }, claims: ['created'] }
```

Profiles are `x`, `cws-youtube`, `youtube-shorts`; H.264/yuv420p, dimensions,
20–40 second story duration, full decode and nonblank poster are checked.
`contain` is explicit and pads instead of squeezing a native UI into 9:16.
Vertical readability and story/captions must be authored by the producer; the
generic renderer does not transplant browser DOM overlays onto native video.
The first renderer is silent (`-an`). No generic timeline editor is provided.

Each capture writes `runs/<UUID>/run.json`, `raw/`, and `deliverables/`. The
atomic `take-a-repo-evidence.json` pointer names only the latest candidate.
Runs never overwrite or merge older media, and a new run never carries approval.
Concurrent writers to one output root are rejected. A failed/interrupted run
makes the current candidate not publishable; inspect the lock owner before
removing a stale `.take-a-repo.lock` after a killed process.

`status` and every review write rehash the report and every delivery/evidence
file. Approval binds the report + entire asset set digest, not just the MP4.
Deleted/changed files fail closed. Scope is explicit; `--scene <producer>` is
diagnostic and cannot approve a full delivery. Run the complete config after
fixing a producer. Evidence CLI exits 1 for needs-fix/blocked (legacy browser
mode retains its documented status-in-JSON behavior).

Request changes stores a note tied to deliverable, file paths, claim IDs and
source reference. `status` returns it for the agent to edit the corresponding
producer/recipe. The next run creates a fresh candidate for user review.
The local page uses host/origin checks, a per-server token and stale-digest
rejection. These protect against cross-site writes, not a malicious local user
who can edit this repository. Agents must not submit user approval themselves.

## Agent discovery and installation

The package is named `take-a-repo`; at the 2026-09-07 check that npm name was
not published. Use a source checkout, a pinned Git installation, or `npm pack`
and install the resulting local tarball. Do not rely on `npx` fetching an
unpublished package. npm publication is a separate, explicitly approved action.

For a host that supports Agent Skills, load `skills/launch-proof` from this
checkout/package using that host's documented skill discovery mechanism. Its
relative reference to `docs/evidence.md` requires preserving the package layout.
The existing Claude plugin discovers the bundled skill directory; a stale
external marketplace entry still requires its owner to update that catalog.
This commit does not install/reconfigure another agent or external marketplace.

A consumer can explicitly adopt this completion rule in its AGENTS.md:

> After implementing a requested feature, run the committed take-a-repo config
> and include its real execution evidence in the completion handoff. Resolve
> agent-owned failures up to the retry budget. Present the final candidate for
> user review; never approve or publish on the user's behalf.

The skill plus consumer rule is the discovery/trigger mechanism. It does not
guarantee that an unconfigured LLM will discover a GitHub/npm repository. Do not
add marketing capture to unrelated work just because the tool is installed.
