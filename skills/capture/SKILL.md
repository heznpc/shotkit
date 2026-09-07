---
name: capture
description: Autonomously produce browser-extension launch assets with take-a-repo, then present the technically verified final media for explicit user approval. Use for CWS/YouTube promo video, X video, YouTube Shorts, store screenshots, listing/privacy evidence, or channel variants. Infer mechanical channel settings, capture, validate, fix, and retry without interrupting the user; bind Approve or Request changes to the exact final file digest.
allowed-tools: Bash(take-a-repo*), Bash(node bin/take-a-repo.js*), Bash(npm run capture:store*), Bash(npm exec -- playwright install chromium), Read, Edit, Write
---

# Produce and approve launch assets with take-a-repo

This skill is the browser-specific path. When completing a product with native,
CLI or API evidence, use the bundled `launch-proof` skill and
`docs/evidence.md`; do not force the product into a web page.

take-a-repo drives the repo's **built** extension with Playwright and writes assets
into the config's `outDir` (default `store-assets/`). A successful run doubles
as a real-bundle smoke test — a screenshot or clip only appears if that feature
rendered from the shipped code. By default, it also writes a handoff pack:
`storyboard.json`, `captions.json`, and `take-a-repo-manifest.json`.

## Autonomous workflow

1. **Translate intent into targets** — infer channel profiles from the user's
   campaign request. Supported targets are `cws-youtube`, `x`, and
   `youtube-shorts`. Do not ask the user to choose viewport, codec, duration,
   thumbnail timing, or editor.
2. **Preconditions** — the repo has a `take-a-repo.config.js`; Chromium is installed (`npm exec -- playwright install chromium`,
   one-time); the config's `build` command succeeds.
3. **Create or update one story** — keep product actions and captions in one
   demo and declare channel variants through `targets`:

   ```js
   demo: {
     name: 'skillbridge',
     targets: ['cws-youtube', 'x'],
     captions: [
       { at: 0.5, text: 'Translate the lesson in place' },
       { at: 18, text: 'Restore the original anytime' },
     ],
     async run({ page, env, demo, target }) { /* one reusable story */ },
   }
   ```

   take-a-repo expands target-specific names, viewport, H.264 MP4, 30-second cap,
   poster frame, and caption treatment. The `youtube-shorts` profile uses
   three-word outline focus chunks with an animated current-word highlight and a
   visual-guide-safe left/bottom placement. Use `targetOptions.<id>` only when the shared
   story genuinely needs target-specific framing or caption tuning.
   If a desktop UI does not reflow at 720×1280, give Shorts a focused `run`
   override and fixture layout that removes secondary panels and enlarges the
   action/result. Never squeeze the complete desktop story into the vertical frame.
   For every localized campaign variant, declare `captionOptions.typography`
   with the exact locale and project-local licensed font files. Prefer a font
   family designed for that script; include fallback faces until glyph QA is
   complete. Do not rely on the operator machine's system fonts for a
   publishable multilingual asset.
4. **Run attempt 1** (from the repo, or pass its path):

   ```bash
   take-a-repo --json --attempt 1
   take-a-repo <path> --json --attempt 1
   ```

   If repeated composition fixes remain unresolved and the repo declares
   `config.calibration`, start `take-a-repo --calibrate`. Keep adjustments inside
   its authored presets, bounded framing/caption controls, and three protected
   regions. Save the profile, trigger the real recapture, and continue only
   from its resulting `publish-ready` or structured `needs-fix` state. Do not
   ask the user to diagnose composition or operate the controls. Once technical
   QA passes, open `take-a-repo --campaign` for the user's final media decision.

   Before npm publication, run the source checkout with
   `node bin/take-a-repo.js --json --attempt 1`, or use a project wrapper such as
   `npm run capture:store -- --json`.

   Useful flags: `--scene <name>` (one story, expanded variant, static scene,
   `description`, or `privacy`),
   `--target <id>` (one channel target),
   `--no-video` (skip the screencast), `--mp4` (also emit an H.264 mp4 of the
   demo — needs ffmpeg on PATH or `TAKE_A_REPO_FFMPEG`), `--no-build` (reuse an
   existing build).
5. **Read the result** — stdout is exactly one JSON object:
   `{ "ok": true, "status": "awaiting-approval", "machineStatus": "publish-ready", "outDir": "...", "manifest": "/abs/path/take-a-repo-manifest.json", "produced": [...] }`.
   Progress logs go to stderr in `--json` mode.
   Read `handoff.automation` for technical repair work and `handoff.approval`
   for the user decision. Do not use the legacy compatibility review summary.
6. **Fix, review, and publish through the gate**:
   - `needs-fix`: apply every `automation.actions[]` item whose owner is
     `agent`, edit the config, then rerun `automation.retryScenes[]` with
     `--attempt 2`. Repeat through `automation.maxAttempts`.
   - `blocked`: automated attempts are exhausted. Report only the concrete
     technical blocker and attempted fixes; ask for technical input.
   - `awaiting-approval`: technical QA passed. Open the Campaign Dashboard and
     present the rendered candidate to the user. Keep the Calibrator under
     Advanced for agent-owned composition work. Do not approve on the user's behalf.
   - `changes-requested`: read the digest-bound decision note, implement it as
     the next agent-owned edit, recapture, and return the new candidate for
     another decision.
   - `approved`: the exact recorded digest passed user review. An authorized
     uploader may publish that digest; any recapture or profile edit invalidates
     the decision.
   - `not-requested`: legacy capture mode; no channel target was configured.
7. **On runtime failure** — exit code `2` = usage/no config found, `1` = runtime
   failure; stdout still carries the single JSON payload
   `{ "ok": false, "error": … }`. Common causes: build failure, Chromium not
   installed, an unknown `--scene`, or a scene's wait timing out (feature didn't
   render).

## Notes

- Runs the full-Chromium channel; headless works (`TAKE_A_REPO_HEADED=0 take-a-repo …` — verified,
  video included) and is the mode to use in CI. Headed-under-xvfb is
  unreliable on CI runners — don't use it.
- Scenes are the repo's own config — to change *what* is captured, edit
  `take-a-repo.config.js`, not take-a-repo.
- `description.from` may point to `STORE_LISTING.md` for copy only or to
  `product.manifest.json` for shared listing + privacy disclosure inputs.
  `privacy-disclosure.md` is a worksheet for store review, not legal policy text.
- CWS assets and SNS demo clips have different jobs. For X/SNS clips, prefer
  `demo.preset: 'sns-video'` (`1280×720`), `demo.mp4: { crf: 18 }`, 20-40
  seconds, short captions, first-result-within-3-seconds, and a
  before → action → result → safety/restore story. Use `sns-twitter`
  (`1200×675`) for static X card images.
- Demo configs can use timed `demo.captions` plus the helper passed to
  `demo.run`: `demo.caption(text)`, `demo.step(text, async () => { ... })`,
  `demo.wait(ms)`, `demo.click(selectorOrLocator, { moveMs, beforeMs, holdMs })`,
  and `demo.select(selectorOrLocator, value, { openMs, holdMs })`. Captions,
  arrow-pointer clicks, and mirrored native-select options render as DOM
  overlays during recording and avoid the top-left disclaimer badge. Always
  use `demo.select()` for a native `<select>` because its OS popup is not part
  of the Playwright page screencast.
- For short-form focus captions, prefer authored timed captions and
  `captionOptions: { mode: 'focus', appearance: 'outline', wordsPerChunk: 3, wordMs: 360 }`. take-a-repo
  animates those words deterministically even when the product demo is silent;
  do not add speech transcription solely to create caption motion. Shorts
  enables this mode by default, while CWS and X stay static unless overridden.
  The resolved style is recorded in both caption and storyboard handoff docs;
  `captions.json` also carries the trim-relative rendered `timeline[]`. Treat a
  `dense-focus-caption` lint as an agent-owned timing fix, never drop words.
- Locale typography is a harness contract, not a prompt-only suggestion. Set
  `typography.locale`, `family`, `minFontSize`, `maxFontSize`, `maxLines`, and
  one or more `fonts[].from` paths. take-a-repo preserves authored separators,
  verifies glyph coverage, embeds and waits for those fonts, then records the
  resolved size and line balance. Fix `caption-locale-missing`,
  `caption-font-not-embedded`, `caption-missing-glyph`,
  `caption-font-load-failed`, `caption-typography-not-applied`,
  `caption-type-fit-failed`, and `caption-unbalanced-lines` before presenting
  the candidate.
- Runtime caption QA measures the actual DOM frames for bounds, overflow, line
  count, outline stroke, missing frames, and timing drift. Treat every resulting
  storyboard warning as an agent-owned config fix and rerun the target.
- `storyboard.json` carries structured lint (`code`, `severity`, `message`,
  `fix`) for agents. Treat those warnings as the edit list for the next
  `take-a-repo.config.js` pass.
- Use `demos: []` for multiple campaign cuts. Each entry needs a unique `name`
  because it becomes `<name>.webm` and optional `<name>.mp4`; `--scene <name>`
  reruns just that clip.
- Use `thumbnail: { at: 1.2 }` for poster frames, `zoom: { scale: 1.04 }` or a
  small `crop` when the UI is too small. Keep storyboard lint on for every
  channel target; `storyboardLint:false` is only for legacy, non-publishing
  smoke clips and produces `needs-fix` for a target.
- take-a-repo is not a timeline editor. It automates the repeatable channel work
  (capture, trim, framing, captions, encode, poster frame, QA) and leaves manual
  editors disabled by default. Use manifest roles instead of guessing files.
- Target workflows default to `automation.manualFallback:false`; manual editor
  recommendations are omitted. Never suggest iMovie, Screen Studio, Canva, or
  manual recapture unless the user explicitly requests a manual fallback.
- Machine `publish-ready` means the final file passed take-a-repo's automated story, codec,
  pixel-format, actual-dimension, actual-duration, full-video decode, thumbnail-dimension, nonblank-frame,
  integrity, and channel-profile checks. It is not user approval. Publication
  additionally requires `handoff.approval.publishable:true` and an authorized
  connector.
- Validate a received pack through `handoff.schemaFiles`; schema paths are
  relative to the manifest directory. On partial runs, compare each asset's
  `runId` with `manifest.run.id` and inspect `state` before assuming it was
  refreshed.
