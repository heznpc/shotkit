# take-a-repo

An execution-evidence and launch-asset pipeline with explicit final user approval.
Browser capture plus native/CLI/API command producers share the `capture()` entrypoint.
Playwright drives browser products; channel profiles, automated QA, the `take-a-repo` CLI, programmatic
`capture()`, and `skills/capture/` Claude Code skill expose the same engine.
Vanilla JS, CommonJS, no build step.

## Run this tool (for agents)

For a runnable non-web example from this source checkout:

```bash
node bin/take-a-repo.js examples/evidence --json
node bin/take-a-repo.js review examples/evidence/product-evidence --json
```

Read `docs/evidence.md` for the producer/check/claim contract and
`skills/launch-proof/SKILL.md` for development-completion handoff. Native inputs
come from real platform tools; do not substitute a web mock. Evidence runs have
isolated directories and whole-file-set approval. Partial evidence runs are
diagnostic only. `status <outDir> --json` rehashes the current candidate.

To capture store/social assets from a repo that has a `take-a-repo.config.js`:

```bash
node bin/take-a-repo.js --config <config-path> --json
node bin/take-a-repo.js <path> --json   # run against another checkout
```

After npm publication, installed projects can use `take-a-repo --json` or
`npm run capture:store -- --json` when the project defines that wrapper.

Prereqs: `npm exec -- playwright install chromium` (one-time); the config's `build`
command must succeed. Headless works (`TAKE_A_REPO_HEADED=0`; verified on macOS + Linux CI,
video included); the local default is headed. Exit codes: `0` ok · `1` runtime
failure · `2` usage / no config. In `--json` mode progress logs go to stderr;
stdout is exactly one JSON object. Useful flags: `--scene <name>`,
`--target <id>`, `--attempt <n>`, `--mp4`, `--no-video`, `--no-build`.
Success JSON carries a technical `machineStatus` plus delivery `status`:
`approved`, `awaiting-approval`, `changes-requested`, `needs-fix`, `blocked`, or
`not-requested`. Agents own `needs-fix` actions and retry without interrupting
the user; after technical QA passes, the user reviews the final media and
chooses Approve or Request changes.
Every run also writes `storyboard.json`, `captions.json`, and
`take-a-repo-manifest.json` unless `handoff:false` is set in config.

## Structure

```
src/
  capture.js     → capture(config, opts): the runner (build→launch→shot→caption→promo→video→describe)
  launch.js      → launchWithExtension / closeContext (persistent context, extension-id discovery)
  extension.js   → stageExtension / patchManifestForLocalhost
  serve.js       → serveDirectory (path-traversal-safe localhost fixture server)
  caption.js     → compositeCaption (disclaimer/caption band, stacked UNDER the shot)
  demo.js        → demo story helpers (caption/pointer + demo.caption/step/wait/click/select)
  demo-caption-focus.js → deterministic short-form caption chunks + active-word frames
  demo-caption-qa.js → measured caption/protected-region composition QA
  demo-select.js → recordable native-select mirror and real value-change action
  calibration.js / calibrator-server.js → tracked profiles + local dashboard API
  approval.js    → digest-bound user approval decisions + publication gate
  channels.js    → autonomous CWS/YouTube, X, and Shorts target profiles
  promo.js       → renderPromoTile (HTML template → image)
  describe.js    → extractListing / renderDescriptionDoc (STORE_LISTING.md → copy)
  presets.js     → PRESETS / resolveSize (CWS + SNS sizes)
  video.js       → demo post-processing: mp4/trim/crop/zoom/thumbnail (real ffmpeg required)
  handoff.js     → storyboard/captions/take-a-repo-manifest JSON contract
  handoff-files.js / handoff-validator.js → integrity, atomic IO, runtime schemas
  image-qa.js    → nonblank thumbnail pixel checks
  publish.js     → publish-ready/needs-fix/blocked target plan
  schemas/       → JSON schemas for the v1 handoff contract
  cli.js         → CLI arg parsing + config resolution (unit-tested)
  index.js       → public API (the contract — don't break exports)
bin/take-a-repo.js   → CLI (thin wrapper over capture(); --json agent contract)
calibrator/      → local constrained composition UI (actual capture media)
skills/capture/  → Claude Code skill wrapping the CLI (Agent Skills format)
test/            → unit tests for the pure/safe modules (no browser)
```

## Invariants (don't regress)

- **`serve.js` path-safety**: never feed the request URL straight into `path.join`.
  Keep the `path.normalize(...).replace(/^(\.\.(\/|\\|$))+/, '')` sanitizer
  (CodeQL `js/path-injection`). There's a test for it.
- **Full-Chromium channel**: always `channel:'chromium'` — the headless-shell
  strips the extension subsystem; never switch to it. Under the full channel,
  headless **works** (`TAKE_A_REPO_HEADED=0`; verified 2026-06-10 on macOS + Linux CI,
  recordVideo included); the local default stays headed for debuggability.
  Headed-under-xvfb is unsupported on CI runners (the 8-bit default breaks
  `Page.captureScreenshot`; a 24-bit screen still failed silently) — run
  headless in CI.
- **Caption band stacks UNDER the shot** (scene captured at `height - bandHeight`,
  band appended) so the final image is the exact preset size and no UI is hidden.
- **Demo captions, arrow pointers, and select mirrors overlay the recorded page**, while the
  disclaimer badge stays top-left. Keep this lightweight: one `demo` or several
  `demos[]` entries, timed captions, `demo.caption/step/wait/click/select`, static
  `zoom`/`crop`, `thumbnail`, and storyboard lint — not a timeline editor.
- **Shorts focus captions are authored-story animation, not transcription**:
  `youtube-shorts` defaults to `captionOptions.mode:'focus'`, three-word chunks,
  current-word emphasis, and a bottom safe offset. Keep CWS/X static by default.
  Preserve every authored word; `dense-focus-caption` means the agent must
  lengthen the beat or shorten its copy before publishing. `captions.json`
  carries the resolved trim-relative frame timeline for downstream adapters.
  Add Whisper-style alignment only as an optional future audio adapter; silent
  product demos already have deterministic caption timing.
- **Localized typography is measured, not guessed**: localized publishing
  configs declare `captionOptions.typography.locale` and project-local font
  files. Preserve authored separators during focus segmentation, verify glyph
  coverage and browser font loading, fit only within declared size/line bounds,
  and treat typography QA warnings as agent-owned fixes. A Skill may author
  copy and emphasis, but the harness owns deterministic measurement.
- **Handoff JSON is the machine boundary**: target workflows use
  `handoff.automation` to fix and retry until technical `publish-ready`; users
  do not read manifests or repair media. They review the resulting media in the
  Calibrator and make the final Approve / Request changes decision. Use
  `assets[].role` and bundled schemas instead of filename guessing.
- **Exception-only automation**: every `needs-fix` action is owned by the agent.
  Escalate only after `automation.maxAttempts` yields `blocked`. Manual editor
  hints are disabled unless `automation.manualFallback:true` is explicit.
- **User approval is the publication gate**: never treat machine
  `publish-ready` as permission to publish. `take-a-repo-approval.json` binds each
  decision to the exact deliverable SHA-256 and calibration profile hash; any
  recapture or profile edit makes the old decision stale. Only an `approved`
  current digest is publishable. Agents must not approve on the user's behalf.
- **Storyboard lint is structured for agents**: runtime logs are human strings,
  but `storyboard.json` carries `code`, `severity`, `message`, and `fix` so the
  next config edit can be mechanical.
- **Calibration is exception-only**: `take-a-repo --calibrate` may adjust only a
  declared layout preset, bounded framing, caption lane/appearance, and up to
  three protected regions. It writes `take-a-repo.calibration.json`, never config
  source. A profile is verified only after a matching real recapture returns
  `publish-ready`; stale profiles stay `needs-fix`. Do not grow this into a
  free-layer, keyframe, or timeline editor.
- **`promo.js` innerHTML** is trusted, build-time content only (the repo's own
  template + config replacements) rendered in a throwaway page — not user input.
- **`config.build`** is a repo-committed command string run via shell on purpose
  (so projects can write `npm run build`); never derive it from external input.
- Unit tests cover only the pure modules; the browser path is verified by running
  a real consumer's capture (browser-extension-starter / skillBridge).

## Generalization rule (for the next starter-series capability)

One npm package (engine + thin CLI), one `*.config.js` contract for irreducible
per-repo intent, **agent surfaces matched to the tool's nature** — fast /
structured-data tools get an MCP tool taking a `path` (like `create-starter`'s
audits); heavy, file-producing build tools like take-a-repo get a `--json` CLI +
Claude Code skill + AGENTS.md run-block instead — plus one marketplace entry.
**The engine never reads project specifics except through the config contract.**
take-a-repo is the reference implementation of the non-MCP branch; mirror
[`create-starter`](https://github.com/starter-series/create-starter) for the
MCP branch.

## Dev

```bash
npm install
npm run install:browser   # playwright chromium (for an end-to-end run)
npm run lint
npm test
```

## Demo story guidance

CWS assets and SNS demo clips are different outputs. CWS screenshots/promo tiles
should be crisp inspection assets. X/SNS demo clips should be 20-40 seconds,
`preset:'sns-video'` (`1280×720`) when possible, H.264 mp4 (`demo.mp4` or
`--mp4`), and a short story: before → action → result → safety/restore. Use
`sns-twitter` (`1200×675`) for static X card images. Show a visible result in
the first 3 seconds, keep captions short, and move clicks or typing slowly
enough to read.
Use `demos: []` for multiple campaign cuts such as `demo-translate`,
`demo-restore`, or `demo-popup`; `--scene <name>` reruns just one clip.
Use `demo.click(selectorOrLocator, { moveMs, beforeMs, holdMs })` for visible cursor
pacing. Native select popups are outside page video; always use
`demo.select(selectorOrLocator, value, { openMs, holdMs })` so real DOM options,
the arrow cursor, and the real value change are recorded. Prefer
`thumbnail: { at: 1.2 }`; use `zoom: { scale: 1.04 }` or a
small `crop` only when the key UI is too small. Storyboard lint must stay on
for channel targets; `storyboardLint:false` is only for legacy, non-publishing
smoke clips and must produce `needs-fix` for a target.
For a desktop product that does not reflow at 720×1280, use the Shorts
`targetOptions` override for a narrower story and capture-only fixture layout.
Do not squeeze the complete desktop page into 9:16. Runtime caption QA must pass
actual bounds, overflow, line-count, stroke, presence, and timing checks.
Prefer one story with `targets:['cws-youtube','x','youtube-shorts']`; take-a-repo
replays the action script with target-specific framing. Read
`handoff.automation`, apply agent-owned fixes, and rerun only
`automation.retryScenes[]`. Once technical QA passes, open the final candidate
in the Calibrator for the user's approval. Treat Request changes feedback as
the next agent-owned edit and recapture. Do not propose iMovie or manual
recapture unless the user explicitly requests fallback editing.
