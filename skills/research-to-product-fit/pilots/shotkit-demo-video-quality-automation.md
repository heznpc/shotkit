# Pilot: shotkit demo video quality automation

Date: 2026-06-17 KST
Target repo: `https://github.com/heznpc/shotkit`

## Goal

Create the first reusable research-to-product-fit pass for improving shotkit
demo video quality without turning shotkit into a general video editor.

The pilot evaluates caption overlays, click highlights, zoom/pan, a
before/action/result story, and short X.com demo format. It stops at small
shotkit-ready TODOs.

## Local Evidence Checked

- `shotkit/package.json`: package `shotkit` is at `1.3.0`;
  scripts are `lint`, `research`, `test`, and `install:browser`; npm package
  includes `src`, `bin`, `skills/capture`, `docs/handoff-conventions.md`, and
  `schemas`, with `./schemas/*` exported. The research-to-product-fit harness,
  templates, and full skill remain repo-internal and are not included in the npm
  tarball.
- `shotkit/README.md`: current scope already includes demo `webm`, optional
  H.264 `mp4`, frame-accurate trim, DOM caption overlays, and 20-40 second
  before/action/result/safety guidance.
- `shotkit/AGENTS.md`: confirms the no-build CommonJS structure and the
  invariant that demo captions are a lightweight overlay, not a timeline editor.
- `shotkit/skills/capture/SKILL.md`: existing capture skill already tells agents
  to prefer `sns-video`, `mp4`, short captions, and a before/action/result story.
- `shotkit/src/demo.js` and `shotkit/test/demo.test.js`: current helper supports
  timed captions plus `demo.caption`, `demo.step`, `demo.wait`, and `demo.click`.
- `shotkit/src/video.js` and `shotkit/test/video.test.js`: ffmpeg post-processing
  already supports H.264 mp4, trim, `yuv420p`, even dimensions, and `+faststart`.
- `shotkit/src/handoff.js`, `shotkit/test/handoff.test.js`,
  `shotkit/test/schema.test.js`, `shotkit/docs/`, and `shotkit/schemas/`: current
  working tree adds handoff JSON docs and schema-backed package surface.

## Consumer Evidence Checked

- `browser-extension-starter/package.json`: the local consumer target was
  checked in the starter-series workspace. It should consume the unscoped
  `shotkit` package after the package-name migration lands.
- `browser-extension-starter/shotkit.config.js`: uses scenes, promo tile, demo
  captions, `mp4: { crf: 18 }`, and `trim: { start: 0, duration: '00:14' }`.
  It includes a fallback helper so the current `1.1.1` package can still run
  the demo while newer demo-story fields remain inert until shotkit is upgraded.
- `browser-extension-starter/.github/workflows/capture.yml`: the capture CI path
  should run the unscoped `shotkit` CLI after the package-name migration lands,
  emit `shotkit-result.json`, and upload png, webm, mp4, `description.md`,
  `storyboard.json`, `captions.json`, and `shotkit-manifest.json` artifacts
  when present.
- `skillBridge/package.json`: `capture:store` runs `shotkit`; store release
  checklist says screenshots should be regenerated with one command.
- `skillBridge/store-assets/RELEASE_CHECKLIST.md`: requires five 1280x800
  screenshots, a promo tile, `demo.webm`, and CWS upload notes; CWS takes a
  YouTube link for video.
- `skillBridge/store-assets/STORE_LISTING.md`: current listing copy centers
  finishing AI courses in 32 languages, in-page tutor, flashcards, bookmarks,
  exam safety, subtitles, protected terms, and offline support.
- `academy-lens/package.json`: no shotkit dependency or config yet; current
  scripts emphasize tests, E2E, fixture capture, lint/format, and zip build.
- `academy-lens/README.md`, `TESTING.md`, and
  `docs/AI_REVIEW_BRIDGE.md`: AcademyLens is a future consumer candidate with
  visual smoke screenshots, store listing text, and CWS-safe remote-code
  constraints, but it is read-only for this pilot.

## Web Research Ledger

| Candidate | URL | Evidence checked | Decision | Product-fit note |
|---|---|---|---|---|
| Playwright video recording | https://playwright.dev/docs/videos and https://playwright.dev/docs/api/class-video | Official docs for video recording and `page.video()` surface | Adopt current base | shotkit already uses Playwright recording; keep this as the trusted capture layer. |
| X Business creative specs | https://business.x.com/en/help/campaign-setup/creative-ad-specifications | Official specs mention H.264/AVC, 1280x720 recommended, 30 fps recommended, 1920x1080 max | Adapt | shotkit's `sns-video` 1280x720 + H.264 mp4 remains a conservative X/social target. |
| playwright-recast | https://github.com/ThePatriczek/playwright-recast | README, package.json, docs/tests presence, MIT license, release `v0.19.0 - Click markers and narration holds` on 2026-05-27 | Adapt, not adopt | Strong pattern match for trace-derived click markers, cursor overlay, subtitles, speed control, and auto zoom. Do not add dependency in pilot because shotkit is simpler and already has a CLI/config seam. |
| Screen Studio | https://screen.studio/create/product-demo-videos | Product page describes smooth mouse movement, draggable zooms, cursor sizing, trim/cut/speed-up | Adapt benchmark | Use as quality bar for visible clicks and zoom/pan, not as a dependency. |
| OpenScreen | https://github.com/siddharthvaddem/openscreen and https://github.com/siddharthvaddem/openscreen/issues/602 | README lists auto/manual zooms, click effects, captions, annotations; GitHub shows archived on 2026-06-07 | Reject dependency, adapt checklist | Popular and relevant, but archived/read-only. Keep feature vocabulary: auto zoom, cursor smoothing, click effects, captioning, export ratios. |
| Recordly | https://github.com/webadderallorg/recordly | README lists auto-zoom suggestions, cursor smoothing, styled frames, timeline zoom/trim/speed, MP4/GIF export | Reject dependency, adapt | Desktop editor scope is too broad for shotkit; useful as a checklist for what "polished" means. |
| Remotion | https://www.remotion.dev/ and https://www.remotion.dev/docs/parameterized-rendering | Official docs describe reusable video templates, props, rendering to mp4/webm/gif/png, and parameterized rendering | Reject for pilot, revisit later | Good future renderer if shotkit needs generated title cards or template-based composites. Too much new surface for the first demo-quality pass. |
| agent-browser | https://github.com/abhinav-nigam/agent-browser | README describes AI-controlled browser recordings, annotations, spotlight, camera zoom/pan, TTS, music | Reject | Broad AI browser/video suite conflicts with shotkit's deterministic, local, config-driven scope. |
| GitHub `product-demo` topic | https://github.com/topics/product-demo?o=desc&s=updated | Topic page shows many newly updated low-star demo-as-code and Claude skill repos | Scout only | Useful for trend monitoring; low maturity means no direct adoption without deeper repo checks. |
| Product demo marketing checklist | https://zumie.io/blog/how-to-make-product-demo-video | Blog lists common mistakes: no zoom on clicks, too many features, raw capture, missing CTA, and suggests 3-5 feature focus | Adapt lightly | Use as a PM/marketing smell checklist, not as technical authority. |

## Project Fit Matrix

| Capability | Source pattern | Local evidence | Decision | Minimal shotkit TODO |
|---|---|---|---|---|
| Short X/social export | X Business specs + shotkit README | Current working tree adds H.264 mp4, `yuv420p`, even dims, `+faststart`, `sns-video`, and warning-only storyboard lint | Adopt, pending validation | Stabilize the quality lint and docs before adding another rendering feature. |
| Caption overlays | shotkit current + playwright-recast subtitle styling | `src/demo.js` already installs DOM captions and tests timing/replay | Adopt | Keep DOM overlay as default. Add docs/tests for caption length and first-caption timing before new rendering tech. |
| Click highlights | playwright-recast click markers, OpenScreen/Recordly click effects | Current working tree adds default `demo.click()` pointer movement plus click ripple, with `highlight: false` escape hatch | Adapt, pending validation | Review whether default-on highlight belongs in core before exposing more click metadata. |
| Zoom/pan | Screen Studio/Recordly auto zoom; playwright-recast auto zoom | Current working tree adds static crop/zoom post-processing, but no timeline renderer | Adapt later | Defer timeline-style zoom/pan until metadata proves useful. |
| Before/action/result story | shotkit README/capture skill already encode this | `demo.step()` can set captions around actions | Adopt | Add a documented "story rubric" template for demo configs: result in first 3s, 3-5 beats, safety/restore final beat. |
| Voiceover/TTS | playwright-recast, agent-browser | shotkit has no API-key dependency and current videos are silent | Reject for pilot | Keep voiceover/TTS out of shotkit until a consumer explicitly needs it. |
| Full timeline editor | Screen Studio, OpenScreen, Recordly, Remotion | shotkit non-goal says not a general video editor | Reject | Record as non-goal; only implement deterministic overlays that are useful in CI. |

## Prioritized TODOs

1. Stabilize the current `demo` quality lint as a documentation-first or
   pure-function pass.
   - Target files: `src/demo.js` or a new small pure helper, `test/demo.test.js`,
     `README.md`, `skills/capture/SKILL.md`.
   - Checks: first caption starts within 0-1.5s, at least one visible-result
     caption, suggested duration <=40s for starter demos, mp4 enabled for
     `sns-video`, captions short enough for mobile.
   - Stop condition: no additional video rendering changes.

2. Stabilize optional click highlight in `demo.click`.
   - Target files: `src/demo.js`, `test/demo.test.js`, README example.
   - Behavior: current working tree uses `highlight: true` by default, moves a
     synthetic pointer to the selector center, then clicks and pulses.
   - Stop condition: no cursor simulation, audio, or timeline editor.

3. Decide whether the new handoff JSON contract belongs in this unit.
   - Target files: `src/capture.js`, `src/handoff.js`, tests around pure handoff
     normalization if available.
   - Contents currently include `storyboard.json`, `captions.json`, and
     `shotkit-manifest.json`, not `demo-timeline.json`.
   - Stop condition: metadata only; no Remotion or playwright-recast dependency.

4. Review the existing consumer fixture upgrade as a separate integration unit.
   - Target repo: `browser-extension-starter`; changes already exist in the
     working tree and should be reported separately from the repo-internal
     research harness.
   - Change: `shotkit.config.js` now uses forward-compatible demo story fields
     and CI now accepts generated mp4 and handoff JSON artifacts when present.
   - Stop condition: do not modify read-only `skillBridge` or `academy-lens`.

## Rejected Or Deferred

- Do not adopt OpenScreen as a dependency: it is archived as of 2026-06-07.
- Do not adopt Remotion yet: useful later, but it creates a second renderer.
- Do not add TTS/voiceover: it introduces keys, provider choice, caching, and
  privacy/cost questions outside this pilot.
- Do not turn shotkit into a desktop editor or timeline UI.

## Next Agent Handoff

- Scout: use Claude by default to add more GitHub topic candidates, but mark
  candidates incomplete unless README, package/config, docs/examples, tests, and
  activity are checked. Use Gemini only for an optional second broad search pass.
- Critic: use a separate Claude session or Codex to challenge whether click
  highlight belongs in shotkit core or in consumer configs; verify no
  store/compliance risk from overlays.
- Integrator: use Codex to first audit the current working tree because TODO 1
  and TODO 2 are already partially implemented; then run `npm run lint`,
  `npm test`, and any focused browser capture that the target consumer supports.
