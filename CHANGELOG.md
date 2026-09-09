# Changelog

All notable changes to `shotkit` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `shotkit demo --for <channel>` delivers an uploadable file instead of a plain
  clip. The channel profile (`x`, `youtube-shorts`, `cws-youtube`) supplies
  viewport, codec, trim, and caption style, and channels are repeatable or
  comma-separated so one run produces every cut. Each delivered mp4 is then
  probed and checked against that channel's published dimensions, codec, and
  duration limit: a miss fails the run and is reported per channel in
  `channels[]`, so "ready to upload" is measured rather than assumed. The
  recording budget defaults to the channel's trim window instead of 20s, and
  `--for` requires ffmpeg (a channel deliverable *is* the H.264 file).
- Zero-config clips now follow one scene spec instead of whatever the target's
  markup happens to yield. `shotkit demo` rewrites the page's headings into a
  fixed shape — open on the title, one beat per content heading in page order,
  close back on the title, evenly paced — and normalizes each caption the way a
  human editor would: nav furniture (`Menu`, `On this page`, `Skip to
  content`, `목차`) is dropped, list numbering and trailing sentence
  punctuation are stripped, case-insensitive repeats and title echoes are
  merged, and long headings are cut on a word boundary at the same 70-char
  ceiling the storyboard linter enforces. The planned script is verified before
  recording starts, so an off-spec script fails the run instead of producing an
  off-spec clip, and the recorded scenes are printed per run and returned in
  `scenes[]` under `--json`. Beats are anchored to the headings themselves, so
  a heading can no longer be skipped because a blind scroll step left it
  outside the window.

### Fixed
- Playwright's "browser not downloaded" failure is rewritten into an install
  command that actually works. Its own hint (`npx playwright install`) can
  resolve a different Playwright than the one shotkit runs under when shotkit
  was started through a bare `npx`, downloading a build shotkit never looks
  at. The docs now lead with `npm i -D demoshot && npx playwright install
  chromium` for the same reason.

### Changed
- The npm package name is `demoshot`: the registry rejects `shotkit` as too
  similar to the existing `shot-kit` package. The project, repository, and
  CLI keep the `shotkit` name, and the package installs both the `demoshot`
  and `shotkit` commands.

### Added
- `shotkit demo <url|dir|file.html>` — a zero-config proof clip for any web
  app. No `shotkit.config.js`: the clip is captioned from the page's own title
  and headings, walks the page with a paced scroll, and lands as
  `demo.webm` (+ `demo.mp4` and a thumbnail when ffmpeg exists). Static
  directories and single files are served on a local loopback port. `--json`
  emits exactly one machine-readable object.
- `launchBrowser` — extension-optional Chromium launch. `config.prepareExtension`
  is now optional: plain web apps capture with `extensionId: null`, and
  `launchWithExtension` remains the strict wrapper.
- Demo configs accept `lint: false` so runtime-captioned walkthroughs skip
  static storyboard lint.
- A `demo` agent skill (`skills/demo/SKILL.md`) so coding agents can record a
  proof clip of what they just built without reading the full pipeline docs.
- An explicit final user approval gate in the Calibrator. Approve and Request
  changes decisions are stored in `shotkit-approval.json`, bound to the exact
  deliverable SHA-256 and calibration profile hash, and exposed through the
  manifest's schema-backed `handoff.approval` contract. Recapture or profile
  changes automatically invalidate stale decisions.
- A local exception-only composition Calibrator (`shotkit --calibrate`) backed
  by tracked `shotkit.calibration.json`: declared layout presets, bounded
  framing, caption lane/appearance controls, up to three protected regions,
  actual capture media, and save-then-recapture verification.
- Protected-region collision QA and profile hashes. Changed calibration stays
  `needs-fix` until the exact profile produces a real `publish-ready` capture.
- Autonomous channel profiles for `cws-youtube`, `x`, and `youtube-shorts`.
  One demo story can declare `targets[]`; shotkit expands target variants and
  applies viewport, H.264, duration-cap, caption, and thumbnail defaults.
- Final MP4 probing through ffprobe plus PNG pixel QA for blank/uniform poster
  frames. The manifest now carries per-target checks and media metadata.
- Publish targets cannot bypass story checks with `storyboardLint:false`.
- `demo.select()` mirrors native select options into page recordings while
  applying the real value change; pointer actions now use a visible arrow and
  click ripple instead of an ambiguous circle.
- Timed captions now support a dependency-free `focus` mode with compact word
  chunks, active-word color/pop emphasis, configurable pacing, and a platform
  safe-area offset. YouTube Shorts enables it by default; CWS and X remain
  static. Resolved caption style is included in storyboard and captions handoff
  documents, along with a trim-relative rendered frame timeline. Dense beats
  preserve their full text and produce an agent-fixable storyboard warning.
- Shorts focus captions default to the transparent `outline` appearance, with
  `panel|outline` preserved in both handoff schemas. Runtime caption QA measures
  actual bounds, overflow, line count, stroke, frame presence, and timing drift
  and routes failures into the existing agent retry plan.
- Exception-only `handoff.automation`: `publish-ready`, `needs-fix`, and
  exhausted `blocked` states, agent-owned fix/rerun actions, `--target`, and
  bounded `--attempt` retries.
- Every handoff pack now bundles its four JSON Schemas, exposes their
  manifest-relative paths, and records byte size plus SHA-256 integrity for
  each delivered file except the self-referential manifest.
- The manifest now carries additive v1 metadata for the agent-ready launch
  asset category, current run selection, per-asset provenance/state, a
  manifest-level review summary, and the number of asset-ready adapters.

### Changed
- Package identity is now the unscoped npm product noun `shotkit`.
- The handoff manifest `tool` field now emits `shotkit`, matching the package
  and CLI identity.
- `--json` success results now return the absolute `manifest` entrypoint.
- Public messaging now leads with the autonomous launch asset pipeline and its
  explicit final user approval gate; Playwright remains the implementation
  mechanism.
- Target workflows no longer route technical diagnosis or routine repair to
  humans. Agents own those retries; users review the technically verified final
  media and make the publication-gating decision. Manual adapter hints require
  `automation.manualFallback:true`.

### Fixed
- Final MP4 readiness now requires a bounded full ffmpeg decode after ffprobe
  metadata inspection, so truncated files with a readable header cannot be
  marked `publish-ready`.
- Storyboard lint now evaluates captions inside the delivered trim window and
  measures the first retained beat relative to `trim.start`; captions before
  the start or after `trim.duration` no longer make a weak final cut look valid.
- Poster thumbnails must match the target channel dimensions in addition to
  passing nonblank pixel QA.
- Campaign runs preserve exhausted `blocked` targets, expose concrete runtime
  errors, and distinguish waiting-for-agent states from an active capture.
- Caption and native-select overlays are isolated from host-page translation,
  so localization products cannot rewrite authored campaign text. Outline also
  applies to direct helper/static captions, and condensed outline sizing now
  works on wide viewports.
- Unsupported caption positions and bottom offsets that leave no viewport room
  can no longer pass storyboard lint and claim `publish-ready`.
- `step(text, fn, options)` now honors flat caption display options (e.g.
  `{ position }`, by analogy with `caption()`) instead of silently dropping
  anything outside `options.captionOptions`.
- `lintDemoStoryboard()` no longer emits a spurious "missing mp4" warning when
  the demo config sets `mp4`/`crop`/`zoom` — the public caller need not pass
  `mp4Requested`.
- A thumbnail-only demo (no mp4/crop/zoom/trim) no longer re-muxes and
  overwrites the source `.webm`; the thumbnail is taken from the original clip.
- Partial handoff runs prune missing outputs, replace every retained format for
  a refreshed logical source, mark untouched assets as `retained`, and flag
  changed retained evidence as `modified` instead of recommending it.
- A fresh `--no-video` run with configured demos now reports an `incomplete`
  review and does not claim storyboard-only adapter readiness.
- Final handoff publication validates all three documents with the packaged
  AJV schemas, rejects duplicate asset IDs/paths, and writes JSON through atomic
  temporary-file renames. Malformed or foreign prior packs are no longer merged
  into a partial run.
- New manifest fields remain additive under contract v1; the original v1
  `positioning` and storyboard `purpose` constants stay unchanged.

## 1.3.0 - 2026-06-18 (source-staged)

### Added
- **Demo story renderer** — demo configs accept a single `demo` or several
  `demos: []` entries with timed `captions`, pointer-highlighted clicks, paced
  cursor movement, static zoom/crop framing, thumbnail frames, storyboard lint,
  and a small `demo` helper (`caption`, `step`, `wait`, `click`) for turning a
  feature checklist into short before → action → result stories.
- **Handoff contract** — emits a `storyboard.json` / `captions.json` /
  `shotkit-manifest.json` handoff pack, with JSON Schemas under `schemas/` so a
  downstream agent can consume the output against a stable contract. The
  conventions are documented in [`docs/handoff-conventions.md`](docs/handoff-conventions.md).
- **Integrations module** for wiring captured assets into a consuming project.

### Fixed
- Handoff caption/beat times are now relative to the delivered (trimmed) clip —
  `trim.start` is subtracted and captions before the clip start are dropped — so
  `captions.json`/`storyboard.json` line up with the mp4, not the raw recording.
- Storyboard fields are coerced to the published schema (object `preset` omitted,
  bare-number `thumbnail` → `{ at }`, non-object `trim` → `null`), so a loosely-typed
  demo config no longer emits a schema-invalid storyboard.
- A scene-filtered or `--no-video` run now MERGES into the existing handoff
  contract instead of overwriting a prior full run's storyboard/captions/manifest.
- Post-processed mp4/thumbnail assets no longer record the source-viewport size
  when `crop` changes the output dimensions (size is omitted rather than wrong).
- A thumbnail seek past the end of a trimmed clip no longer records a phantom
  asset — the file's existence is verified before it is recorded.
- One demo failing (e.g. mp4 requested with no ffmpeg) no longer aborts the
  remaining demos, the handoff pack, or temp-dir cleanup.
- Storyboard lint no longer throws on a malformed `trim.duration`/caption time;
  it surfaces as a lint warning, as documented.
- ffmpeg arg/filter validation: a zero/negative `crop` dimension, a non-finite
  `mp4.crf`, or a NaN `zoom` offset now fail with a clear shotkit error instead
  of an opaque ffmpeg parse failure.
- `demo.captions` must be an array — validated at config-normalize time (fail
  fast) rather than late, mid-capture.
- Handoff readiness no longer claims `high` confidence for a recommendation with
  no captured clip, and the source `.webm` is surfaced to video editors even
  when no mp4 was produced.
- Added an ajv (draft 2020-12) schema-validation test that checks emitted
  storyboard/captions/manifest documents against `schemas/`.

### Notes
- Source files are versioned at `1.3.0`, but no `v1.3.0` GitHub release tag or
  public npm publication is assumed until the release step is cut.
- The demo post-processing pipeline (`webm → H.264 mp4` with `+faststart`,
  frame-accurate trim) shipped in 1.2.0 and remains available; it requires an
  `ffmpeg` on `PATH` or `SHOTKIT_FFMPEG`.
- The npm package surface is controlled by `package.json` `files`
  (`src`, `bin`, `skills/capture`, `docs/handoff-conventions.md`, `schemas`).
  The repo-local research harness (`scripts/`, `skills/research-to-product-fit/`,
  generated `research-runs/`) is not published.

[Unreleased]: https://github.com/heznpc/shotkit/compare/v1.2.0...HEAD
