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
positive duration within the channel maximum, full decode and nonblank poster
are checked. The 20–40 second story length is guidance, not a minimum: never pad
a short demonstration merely to satisfy it.
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

## Source/build freshness (opt in for release capture)

Declare `evidence.inputs` (relative files/directories, including scenario helpers,
fixtures, config, lockfile and installed engine source) and `evidence.buildOutputs`
(the actual built product). The engine hashes sorted paths and bytes, including
untracked files and additions/deletions inside each declared directory. Missing
inputs and symlinks fail closed. Keep output directories out of inputs.

Inputs are measured before the build, build outputs after it, and both are checked
again after capture. `--no-build` cannot create a release candidate when a build
and inputs are declared. `status` and review remeasure the same trees; changed or
missing source/build requires recapture, even when the version string is unchanged.
A copied review pack still allows file inspection, but cannot be approved on a
machine without its declared source/build inputs. Declare all transitive inputs:
undeclared external dependencies are outside this freshness guarantee.

`fingerprintInputs(root, paths)` and `evidenceState(outDir)` are public APIs for
consumer-specific loaded-bundle observations and approved asset handoff. Consumers
must record the actual runtime version and staged bundle separately when fixture
patches change the production build. Version equality alone is insufficient.

## Incremental production

`production` is an opt-in path over evidence configs. The ordinary capture path
continues to execute producers. The production engine makes no model calls;
`modelCalls: 0` describes this engine, not the surrounding coding agent or custom
producer commands. Reuse saves repeated capture/render work and lets agents send
small editorial patches. Observation context measures payload reduction; actual
model token savings are not yet benchmarked.

```bash
node bin/take-a-repo.js production plan examples/evidence --config production.config.js --json
node bin/take-a-repo.js production run examples/evidence --config production.config.js --json
node bin/take-a-repo.js production status examples/evidence --config production.config.js --json
```

Each producer can declare:

```js
reuse: {
  mode: 'local-inputs',
  inputs: ['src', 'fixtures', 'scripts/collect.js', 'package-lock.json'],
  maxAgeSeconds: 86400, // 1..604800, measured from the ORIGINAL capture
  environment: ['FEATURE_MODE'], // optional; values are hashed, never recorded
}
```

Declare every transitive local dependency and keep outputs outside the inputs.
Do not enable this for live services, mutable remote URLs or undeclared state.
Imports cannot opt into execution reuse. The engine checks input bytes, producer
recipe, declared environment, engine/runtime identity, capture age and every
cached artifact hash. Build reuse additionally requires `evidence.inputs` and
`evidence.buildOutputs`; undeclared builds always rebuild and recollect.
Use `production run --fresh` to force build, capture and rendering.
Pass `production run --attempt <n>` on retries to enforce the existing
`automation.maxAttempts` budget; exhausted failures return `blocked`.

No-change runs return the same exact candidate and its current review status.
New candidates contain independent copies of reused files, the original capture
run/time/source, and `reused-producer-asserted` checks. They never inherit approval.
If only rendering fails, including on the first run, a separate cache pointer
retains the verified footage for repair and observation. Execution, integrity and
input freshness checks must still pass; the failed candidate cannot be approved.
That pointer grants no publication authority. Source changes
invalidate the current candidate immediately on status/review.

The saved `take-a-repo-project.json` holds bounded editorial overrides; the
consumer config still owns producers, claims, sources and channel intent.
`project-history/<project-id>/<revision>.json` preserves each revision. Edits
require the current `baseRevision` and cannot change evidence or approvals:

```json
{
  "baseRevision": 1,
  "operations": [{
    "deliverable": "demo-x",
    "set": {
      "trim": { "start": 1, "duration": 24 },
      "captions": [{ "id": "intro", "start": 0, "end": 4, "text": "Show the result first" }]
    }
  }]
}
```

Save the patch as JSON, then run `take-a-repo production edit <repo> --patch
<patch.json> --json` and `take-a-repo production run <repo> --json`. Pass the same
`--config` when using a nondefault config. `set` accepts trim, crop, zoom,
thumbnail, captions, `captionOptions`, `protectedRegions` and `editorial` overrides.
Caption style and nested typography keys merge; arrays and framing objects replace.
Changing a font keeps the other declared typography settings and invalidates output
reuse. Set trim/crop/zoom/thumbnail to `null` to disable the configured override;
`unset: ["zoom", "captionOptions.typography.minFontSize"]` restores only those
config defaults. Set and unset paths cannot overlap in one operation.
`{"deliverable":"demo-x","reset":true}` restores config defaults. Saved edits
are also removable with `reset` after their deliverable is renamed or removed from
the config; reset all obsolete IDs in one patch before running the new config.
History remains intact. After an interrupted project save, revision numbers may
skip an orphaned history entry instead of overwriting it. Captions are
ordered, non-overlapping intervals relative to the edited output, with optional
`fontSize` from 18 to 96 (within declared typography bounds). Invalid edits leave the revision unchanged.

Videos require `fit: 'contain'`. Both ordinary `capture()` and `production run`
apply saved edits and use the same video renderer. Ordinary capture still executes
producers; production is the explicit incremental path. Video captions use the
existing demo overlay, word segmentation, focus keyframes and typography QA.
Shorts inherits focus/outline, three-word chunks and its safe bottom offset;
CWS/X retains static defaults. Explicit caption options override channel defaults.
Unknown style fields fail instead of silently disappearing. Static crop/zoom and
thumbnail time are honored in both captioned and uncaptioned outputs.

Keep a short complete caption visible together with per-caption `focusChunks`, for example
`text: 'Claude 같은 전문 용어는 그대로', focusChunks: ['Claude 같은 전문 용어는 그대로']`.
`Claude 같은` modifies `전문 용어`: replacing it with the rest of the sentence
forces the viewer to reconstruct a single thought across two screens. This is
not a suitable temporal split. Change emphasis within the complete caption;
if it does not fit, measure line wrapping/font size within the declared bounds
or rewrite the complete sentence. Multiple temporal chunks need independently
readable statements and an editorial reason, not just a word-count target.
This works in production edits and timed browser demo captions. Every original
word, separator and punctuation mark must be preserved at complete word boundaries;
invalid partitions fail before saving an edit. Keeping a complete sentence visible
must preserve sequential animation on every word, not replace it with selected
keywords. Omit `focusCues` for automatic timing. Optional cues override timing;
for a three-word caption: `[{at:0,chunk:0,word:0},{at:0.4,chunk:0,word:1},
{at:0.8,chunk:0,word:2},{at:1.2,chunk:0,word:null}]`. Cue `at` is seconds from
caption start; `chunk` and `word` are zero-based. Cues start at zero, advance
monotonically, highlight every word once in reading order for at least 120ms,
and preserve phrase reading time. `null` releases emphasis only after the complete
phrase. Skipped/reordered words and premature releases fail before saving.
Without cues, word emphasis follows
`wordMs` and releases after the phrase has been read, instead of leaving the last
word highlighted throughout a long hold. Without authored phrases, `wordsPerChunk` is a target count, allowing
one extra word to avoid a trailing singleton (except intentional one-word mode).
Automatic grouping cannot judge meaning. Review the complete phrase in the final
video, including its transitions, placement relative to the product, and hold time.
`position: 'bottom'` centers the caption lane; `bottom-left` reserves the right side
for channel controls. Choose `bottomOffset` against the actual content and declared
protected regions. Passing geometry/pixel QA does not establish editorial quality.

Caption intervals must leave enough reading time (authored words times `wordMs`,
360 ms by default). Storyboard warnings, measured overflow, missing glyphs/fonts,
and collisions with up to three output-coordinate `protectedRegions` block the
candidate. Localized captions require `captionOptions.typography`
with `locale` and project-local `fonts`, in config or saved edits. The renderer samples the shared
entrance, exit and word-pop animation on a deterministic 30 fps clock, checks decoded
transition/settled frames against the same framed source and alpha overlay,
and emits a `caption-timeline` JSON artifact with resolved style and word timing.
Intermediate caption images are removed after rendering or failure; source footage
and the portable timeline remain. No fixed caption band is imposed on video. The screenshot caption-band contract
is unchanged. This version has no audio editor or multi-clip timeline UI.

Capture dependencies are fingerprinted separately from editorial rendering.
Changing the offline renderer invalidates output reuse, not intact source footage.
Each producer and each deliverable is hash-checked independently: a damaged poster
requires rendering again, and a failed sibling producer does not discard successful
captures. Failed candidates never become approvable through cache reuse.

Adding editorial captions requires a producer video asset with
`captionState: 'none'`: an uncaptioned master, not an already captioned export.
Other values are `'burned-in'` and `'unknown'`; omitted metadata means unknown.
New captions on either are rejected before rendering, because an overlay cannot
replace text already in the source pixels. Clearing project captions only removes
the project's own caption layer. Existing videos without new captions remain
renderable. This is a producer declaration, not an automatic OCR guarantee:
inspect external footage before declaring it clean. Browser captures carry their
authored-caption state through the evidence adapter, and rendered captioned
outputs are marked burned-in. Capture the reusable master without `demo.captions`
or `demo.caption/step` text, then keep editable captions in the production project.
An old captioned master must be replaced or recaptured once; subsequent copy
changes reuse the clean master without another capture.

`plan` returns producer and delivery actions; `run.metrics` reports executed and
reused producers, rendered and reused deliverables. CLI run/edit responses stay
compact; `status` and the referenced run report provide details on demand. Review the finished candidate
with the editorial review loop below, then use `review <outDir>` for the user's
decision. Editing the project or changing its
fonts makes the old candidate stale; only a matching final user decision permits
approved export. Public APIs: `planProduction(config, { cwd })`,
`runProduction(config, { cwd, fresh })`, `editProduction(config, patch, { cwd })`.

Existing evidence configs, `capture()`, legacy CLI commands and v1 evidence
reports remain supported. Migrating an output directory requires no file rewrite:
the first production run creates the project and collects fresh evidence because
older runs have no reuse contract. Subsequent production runs can reuse it.
Earlier runs and decisions remain in their original directories; approval is
never transferred to the new candidate. Running the legacy capture command again
executes producers again, applies the saved editorial project, and leaves its revision intact.

### Final-composition editorial review

New evidence runs containing video return `machineStatus:publish-ready` when
technical checks pass, but remain `status:needs-fix` until the agent records a
critique. Proof-only and historical runs retain their existing approval behavior.
This record is an accountable judgement, not an automatic quality score or a user
decision. There is no built-in model call.

Author `editorial: {objective,audience,rationale,beats}` on each video or via
`production edit`. Every beat needs `id`, semantic `role`, output `start/end`,
`subject`, `expectedChange`, `attention` and `holdReason`. Describe what the viewer
should see and why the duration is warranted; consecutive beats cover the whole
output, including deliberate holds. Metadata itself proves nothing.
The exact schema and editable fields are included in `production context`.

```bash
take-a-repo production review-context <repo> --deliverable demo-x --max-frames 16 --json
# Watch the returned final video and inspect frame paths, then write a critique.
take-a-repo production review <repo> --report critique.json --json
take-a-repo review <outDir> --json
```

`review-context` samples the composited MP4 at beat/caption boundaries and across
the duration, with a bounded budget. It is not complete event coverage. Request
additional `--from/--to` ranges or `--crop x,y,w,h` for suspect transitions; use
full frames to judge placement and crops to read details. Width defaults to the
output width, capped at 1920, without upscaling. Context and pixels are hash-bound
to the candidate and reused on repeat requests.

The returned `reviewContract` supplies the report shape. For every video, submit
context IDs and five distinct checks: `evidence`, `composition`, `legibility`,
`pacing`, `continuity`. Each requires `pass|fail`, an observed timestamped reason
and inspected frame IDs. A passing report needs at least two inspected full
frames per authored beat. These checks establish traceability, not proof that
an agent actually watched or judged well. Failed checks remain agent-owned work;
repair via edit/run and critique the new digest. Only a passing current critique
enables the separate user approval; it never authorizes publication.

### Reusable video observations and bounded context

For configs with video deliverables, run this loop after the first production run:

```bash
take-a-repo production observe <repo> --json
take-a-repo production context <repo> --source recorder:video --from 4 --to 12 --max-frames 4 --json
# Inspect the returned frame paths, author a revision-bound trim/caption patch,
# then use production edit --patch patch.json and production run.
```

`observe` samples existing source footage with FFmpeg. It stores PNG frames and
their actual presentation times, normalized to the source video's start, in an
immutable index under `observations/`. The atomic `take-a-repo-observations.json`
pointer selects the latest complete analysis per source. Indexes and frames are
rehashed on use. Source bytes, sampling settings, analyzer changes or FFmpeg
changes invalidate analysis reuse; trim/caption edits do not. Interrupted or
damaged analysis can be rebuilt without modifying evidence runs or approvals.
These files describe archived footage, not proof that a current build works.

Optional config-owned limits (defaults shown):

```js
production: {
  observations: { intervalSeconds: 2, width: 480, maxFrames: 240 },
}
```

`width` bounds both thumbnail dimensions. For long recordings the interval grows
to respect the total frame budget; the actual interval is reported. Allowed
ranges are 0.25..60 seconds, 160..1280 pixels and 2..1000 frames.
This first version samples frames only: no transcription, OCR, semantic search,
automatic scene detection or model call is performed. Brief events between
samples can be missed. Increase sampling density when the requested edit needs
more detail. `context --resample --width 1280` decodes a requested range directly
from the source, and an empty indexed range automatically uses detail sampling;
it does not merely select more entries from the same sparse grid.
Detail requests report decoded `atSeconds` separately from `requestedAtSeconds`,
to millisecond precision. Duplicate source frames are collapsed and out-of-range
frames excluded; very narrow ranges in sparse footage can still be empty.

`context` defaults to an eight-frame overview of the source; `--source` is required
when multiple sources are configured. Ranges are source seconds, inclusive at
`from` and exclusive at `to`. At most 2..32 frames may be requested. If a range
contains more samples, context selects evenly across it and reports the omitted
count via `coverage`. The result includes the current `baseRevision`, configured
deliverables, effective saved trim/captions and channel duration constraints,
so an agent can author an edit
without loading the entire project or run report. Captions still use output
seconds; trim uses source seconds. Returned paths are references: the model must
actually inspect the images before judging their content.
`source.captionState` and `constraints.canAddCaptions` also explain whether the
source accepts a new caption layer, before the agent authors a patch.

`observe.metrics` measures analysis/reuse counts and elapsed wall time.
`context.metrics` compares the same JSON frame-record representation and image
bytes for all stored samples versus the selected subset. It excludes the rest
of the context envelope and does not compare against every frame of the original
video. `actualModelTokens: null` is intentional: image tokenization, reasoning
and provider prompt caching are not measured by this local engine. Public APIs
are `observeProduction(config, { cwd, source })` and
`productionContext(config, { cwd, source, from, to, maxFrames })`.

## Migration and platform boundary

Canonical package, binary, config, environment prefix, schemas and skills use
`take-a-repo`. Historical changelog/research records retain their original names.
The canonical GitHub repository and Git remote are `heznpc/take-a-repo`.
The former `heznpc/shotkit` URL redirects to it. No implicit fallback to a
former npm name or old output manifest is provided. Consumers may keep an
explicit deprecated wrapper that forwards to the current evidence pipeline.

Currently implemented: browser/extension capture; executable CLI/API producers;
native producer contract and runnable macOS AppKit fixture. Native media use the
same hashing, decoding, claim checks, channel rendering and whole-set review.
Design intent: let product-owned platform drivers supply actual observations.
iOS/Android simulators, physical devices, desktop UI and remote services can be
covered by those drivers; they are not built-in or verified merely by selecting
`kind: native`. Planned: no additional platform driver is promised by this change.
Non-goals: substitute web mockups for native apps, fabricate service responses as
live evidence, or become a timeline editor. Redacted: private service/account data
must stay outside delivered evidence. Audio/JPEG ingestion and generic native
action DSLs are not implemented.

Approved handoff: `exportApprovedEvidence({ outDir, root, mappings, receipt })`
requires a currently approved complete candidate and copies selected asset bytes
without transforms. A mapping uses `producer-id:asset-id` (or
`deliverable:asset-id`) and a contained relative destination. The receipt is
invalidated before writes and committed last with run ID, review digest and file
hashes. `verifyExportedEvidence({ root, receipt })` detects later changes before a
consumer builds/uploads those files. This function verifies the export receipt;
it is not a new authorization to publish, and does not re-evaluate source freshness
on an already exported release. Re-run capture/status for a new product build.

Extension paths for future producers (official references checked 2026-09-15):
[Appium platform drivers](https://appium.io/docs/en/2.12/ecosystem/drivers/) cover
native iOS, Android and desktop through separate driver installations. Playwright
labels its [Electron](https://playwright.dev/docs/api/class-electron) and
[Android Chrome/WebView](https://playwright.dev/docs/api/class-android) adapters
experimental. These are integration candidates, not claimed take-a-repo support.
