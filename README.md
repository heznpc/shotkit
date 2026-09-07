<div align="center">

# take-a-repo

**Your agent built it. take-a-repo shows it running.**

Collect real execution evidence from browser, native, CLI and API products.
Connect claims to observed checks, create review assets, and approve exact files.
Browser recording is one producer, not the product boundary.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node ≥ 22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](.nvmrc)

**English** | [한국어](README.ko.md)

</div>

---

![take-a-repo demo — a captioned proof clip recorded from one command](docs/media/quick-demo.gif)

```bash
npm ci                                      # in this source checkout
node bin/take-a-repo.js examples/evidence --json   # real CLI + API, no browser
node bin/take-a-repo.js review examples/evidence/product-evidence --json
```

> The package and command are both **`take-a-repo`**. The npm name was **not
> published** at the 2026-09-07 check. Use this checkout or a local tarball below.

The [product evidence contract](docs/evidence.md) covers command producers,
native media, feature checks, isolated runs, channel rendering and final review.
The runnable AppKit example is in `examples/evidence/native` (macOS CLI tools).

For a quick **browser appearance clip**, install Chromium and run
`node bin/take-a-repo.js demo http://localhost:3000`. This path is capture-only:
rendering and scrolling a page do not establish that its product features work,
and quick clips have no publication approval. Use a configured evidence or
browser launch workflow for final review.

The quick browser path writes
`take-a-repo-demo/demo.webm`, plus `demo.mp4` and a thumbnail when ffmpeg is
installed. **No config file** — captions come from the page's own title and
headings, and the clip walks the page with a paced scroll. Coding agents get
the same contract as everywhere else in take-a-repo: `--json` prints exactly one
JSON object on stdout, and exit codes are `0 ok · 1 failure · 2 usage`.

**And it grows.** The same engine is a full launch-asset pipeline for browser
extensions: deterministic Chrome Web Store screenshots, promo tiles,
storyboarded SNS demo clips with pointer-highlighted actions, final-file QA
(ffprobe + full decode), and a digest-bound human approval gate — everything
below this line.

---

> **Part of [Starter Series](https://github.com/starter-series)** — reusable launch tooling. The project, package and CLI share the `take-a-repo` name; npm publication is a separate release step.

## Status & Scope

- **Cross-product evidence** — `config.evidence` executes repo-owned browser/native/CLI/API producers, measures typed evidence, links claims to checks, creates isolated candidates and proof pages/channel videos, and rehashes the entire file set at final review. See [the contract and runnable consumers](docs/evidence.md). Imported checks stay unverified. Platform automation drivers remain external producers.
- **Currently implemented** — An autonomous launch asset **pipeline** whose Playwright engine builds and drives the *shipped* extension, expands one story into `cws-youtube`, `x`, and `youtube-shorts` variants, applies target viewport/H.264/trim/caption/thumbnail defaults, probes final MP4 metadata with ffprobe, fully decodes the delivered video with ffmpeg, checks poster dimensions and pixels for blank-frame failures, and emits a technical `machineStatus` of `publish-ready`, `needs-fix`, or `blocked`. A separate digest-bound approval gate returns `awaiting-approval`, `changes-requested`, or `approved` as the delivery status. The schema-backed pack carries source evidence, captions, run provenance, integrity, user decisions, and agent-owned retry actions. The same engine is exposed through the CLI, `capture()`, skill, and AGENTS.md run-block.
- **Story renderer** — Demo configs can use one `demo` or several `demos: []` entries, timed static or Shorts-style focus captions, pointer-highlighted clicks, recordable native-select changes, paced cursor movement, static zoom/crop framing, thumbnail frames, storyboard lint, and a small `demo` helper (`caption`, `step`, `wait`, `click`, `select`) so an agent can turn a feature checklist into 20-40 second before → action → result stories without pulling in a general video editor.
- **Design intent** — *One engine, many surfaces — matched to the tool's nature.* take-a-repo is a heavy, file-producing build tool, so its surfaces are CLI (+`--json`), skill, and CI — not MCP (see Non-goals). Captures are **deterministic** (login-free fixtures, frozen data) and the run **doubles as a real-bundle smoke test** — a screenshot only appears if that feature rendered from the shipped code. **Trademark-safe** by construction: a disclaimer band is composited onto every shot.
- **Non-goals** — An **MCP server** inside take-a-repo (agents with a shell get a better contract from `--json` + the skill). Removing the per-repo **story/action config** (which product state proves the claim is irreducible intent). A general-purpose timeline editor or hosted demo platform. Repeatable channel work is automated; manual editors are fallback-only and disabled unless explicitly requested.
- **Redacted** — none. Ships no private data, credentials, or third-party identifiers.

## Install

```bash
npm ci
npm pack                          # produces take-a-repo-1.5.0.tgz
# In a consumer checkout, install that exact local tarball:
npm i -D /absolute/path/to/take-a-repo-1.5.0.tgz
# Only browser producers need this:
npx playwright install chromium
```

Or work from this repository:

```bash
npm ci
npm run lint
npm test
node bin/take-a-repo.js --help
```

The checkout bundles `skills/launch-proof`, `skills/capture`, and `skills/demo`.
Load them through your host's Agent Skills mechanism; the external Starter
Series marketplace must be updated before its renamed entry can be relied on.
See [discovery and the consumer completion rule](docs/evidence.md#agent-discovery-and-installation).

After local installation, in a repo with a config:

```bash
npx --no-install take-a-repo --json
```

> take-a-repo launches the **full Chromium** (`channel: 'chromium'`) — never the default headless-shell, which strips the extension subsystem. **Headless works** (`TAKE_A_REPO_HEADED=0`; verified on macOS and Linux CI, video included) and is the CI default in the starter's capture workflow; the local default stays headed for easy debugging. Headed-under-xvfb proved unreliable on CI runners (the 8-bit default breaks Chromium's screenshot capture, and a 24-bit screen still failed silently) — run headless in CI.

## Usage

The zero-config path needs no file at all:

```bash
take-a-repo demo http://localhost:3000   # captioned proof clip of any web app
take-a-repo demo ./dist --duration 30    # static dir, longer clip
take-a-repo demo --help                  # all options
```

Need a file you can actually upload? Name the channel and it comes out sized,
trimmed, captioned, and **verified against that channel's published limits**:

```bash
take-a-repo demo http://localhost:3000 --for x                # 1280×720, ≤140s
take-a-repo demo http://localhost:3000 --for youtube-shorts   # 720×1280, focus captions
take-a-repo demo http://localhost:3000 --for x,cws-youtube    # both, one run
```

Each channel adds `demo-<channel>.mp4` plus a poster frame. The run fails if a
delivered file misses its channel's dimensions, codec, or duration cap, so
"ready to upload" is measured rather than assumed. `--for` needs ffmpeg.

For the full pipeline, add a `take-a-repo.config.js` (the per-repo capture
contract), then:

```bash
take-a-repo                         # produce everything into outDir
take-a-repo --scene 01-feature      # just one scene/promoTile/demo/demos entry, "description", or "privacy"
take-a-repo --target x              # render/retry only the configured X variants
take-a-repo --attempt 2 --json      # next autonomous fix attempt
take-a-repo --campaign              # choose a recipe, produce, and review final media
take-a-repo --calibrate             # open the local composition calibrator
take-a-repo --no-video              # skip the screencast (faster/CI)
take-a-repo --no-build              # use an already-built bundle
take-a-repo ../my-extension --json  # run against another checkout; JSON result on stdout
```

Outputs land in `outDir` (default `store-assets/`): `<scene>.png`, `<promoTile>.png`, `<demo>.webm`, optional `<demo>.mp4`, optional `<demo>-thumbnail.png`, `description.md`, optional `privacy-disclosure.md`, and, by default, `storyboard.json`, `captions.json`, `take-a-repo-manifest.json`, plus four schemas under `schemas/` (`handoff: false` disables the handoff pack). The first review decision creates `take-a-repo-approval.json`.

### Campaign Dashboard

Run `take-a-repo --campaign` to open the local campaign dashboard. A channel-targeted
story becomes a Campaign Recipe automatically; the recipe owns its configured
channel profiles, so the user selects one story rather than assembling outputs
one by one. The dashboard starts production, follows agent-owned capture and QA,
and presents the resulting media for the user's digest-bound Approve or Request
changes decision.

Recipe labels can be added without changing the existing demo contract:

```js
module.exports = {
  campaign: {
    defaultRecipe: 'before-after-proof',
    recipes: [{
      id: 'before-after-proof',
      name: 'Before / After Proof',
      description: 'Show the original workflow, the product action, and the verified result.',
      story: 'launch-story',
      targets: ['cws-youtube', 'x', 'youtube-shorts'],
    }],
  },
};
```

The existing Calibrator remains available through `take-a-repo --calibrate` and the
dashboard's Advanced control. Campaign selection is stored separately in
`take-a-repo-campaign.json`; it does not rewrite config source or replace the
manifest, calibration, or approval contracts. Projects without
`config.calibration` can still use the Campaign Dashboard; Advanced is exposed
only when calibration is configured.

The dashboard records feedback and follows output files, but it does not edit a
consumer repo by itself. `needs-fix` and Request changes therefore mean that an
attached coding agent must read the manifest/approval note, apply the source or
config edit, and recapture. The UI reports these as waiting states; only an
active capture is labeled as work in progress, and exhausted attempts remain
`blocked` instead of being presented as an active retry.

### Composition Calibrator

When automated retries cannot settle a vertical composition, a repo can expose
a small set of authored layout presets and a tracked calibration document:

```js
module.exports = {
  calibration: {
    from: 'take-a-repo.calibration.json',
    layouts: ['focus-column', 'compact-column'],
  },
  demos: [{
    name: 'launch-story',
    targets: ['youtube-shorts'],
    async run({ page, calibration }) {
      // Apply calibration.layoutPreset to capture-only product layout CSS.
    },
  }],
};
```

Run `take-a-repo --calibrate` to open the local-only dashboard. It previews the
actual captured MP4 and intentionally limits adjustment to the declared layout
preset, 1.00-1.20 framing, caption lane/appearance, and at most three protected
UI regions. Save writes `take-a-repo.calibration.json`; it never rewrites the
CommonJS config. Recapture replays the real story and current profile, and only
a matching `publish-ready` result marks that profile verified. Changed or stale
profiles remain `needs-fix`.

This is an exception-only calibration surface, not a layer canvas, timeline,
keyframe editor, or replacement for autonomous QA. Agents can operate the same
controls while fixing composition. Once the exact recapture passes technical
QA, the dashboard presents that final media to the user with Approve and
Request changes controls.

### Handoff Pack

The handoff pack is primarily an internal machine boundary: agents use it to
fix and retry until channel assets are publish-ready. It is not a request for a
human to inspect JSON or edit media. The human reviews the rendered candidate,
not the repair mechanics.

- `storyboard.json` — demo names, audience, viewport, trim/framing hints, beats,
  structured storyboard lint warnings, and suggested next tool.
- `captions.json` — portable caption timings and text per demo.
- `take-a-repo-manifest.json` — the entrypoint: asset inventory and integrity,
  run/freshness metadata, bundled schema paths, and
  `handoff.automation` with target checks and agent-owned retry actions, plus
  `handoff.approval` with the final publication gate.
- `take-a-repo-approval.json` — created after the first decision; binds Approve or
  Request changes to the exact media SHA-256 and calibration profile hash.
- `schemas/*.schema.json` — local validation contracts, copied into every pack
  so a downstream agent does not need the installed npm package.

Target workflows omit manual editor recommendations by default. Targetless
legacy runs may still expose `adapterHints`; setting
`automation.manualFallback:true` restores them for an explicitly requested
manual path. Repo fixtures and the story/action script remain the repeatable
source of truth in either mode.

The convention is versioned and schema-backed. `$schema` values are stable URN
identifiers; `handoff.schemaFiles` resolves them to files inside the output pack.
Every delivered file except the self-referential manifest carries byte size and
SHA-256 integrity metadata. See
[`docs/handoff-conventions.md`](docs/handoff-conventions.md) and the packaged
schemas under [`schemas/`](schemas/).

### Autonomous channel targets

Keep one product story and declare destinations. Do not set viewport, codec,
thumbnail, or duration mechanically unless a target genuinely needs an
override:

```js
demo: {
  name: 'skillbridge',
  targets: ['cws-youtube', 'x', 'youtube-shorts'],
  captions: [
    { at: 0.5, text: 'Translate the lesson in place' },
    { at: 18, text: 'Restore the original anytime' },
  ],
  async run({ page, env, demo, target }) {
    // Reusable product actions. target contains the current channel profile.
  },
}
```

The story expands to `skillbridge-cws-youtube`, `skillbridge-x`, and
`skillbridge-youtube-shorts`. Landscape targets use 1280×720; Shorts uses
720×1280. All target variants receive H.264/yuv420p, a 30-second cap, a poster
frame, and automated final-file checks. The Shorts profile also turns timed
captions into three-word outline focus chunks, highlights the current word, and
keeps the overlay inside YouTube's visual-guide safe region. CWS and X retain
the quieter static panel style. `targetOptions.<id>` is available for a
channel-specific story, framing, caption, or short video disclaimer override.

A responsive product can replay one `run` function for every target. A desktop
surface that does not reflow cleanly at 720×1280 needs a focused Shorts override:
remove secondary panels, enlarge the one action/result pair, and use a
target-specific `run` (plus capture-only fixture CSS when needed). Do not scale
the full desktop story into a vertical canvas or treat a center crop as mobile
composition.

The default policy is exception-only: `needs-fix` actions belong to the agent,
which edits the config and reruns `automation.retryScenes[]` with an incremented
`--attempt`. Technical input is requested only when `blocked` is reached after
`automation.maxAttempts` (default 3). After technical QA passes, the user always
reviews the final candidate. Request changes sends the note back into the agent
loop; Approve unlocks only the exact reviewed digest. Manual editor hints appear
only with `automation: { manualFallback: true }`.

Localized campaign variants can opt into deterministic, measured typography.
Declare the authored locale and project-local font files; take-a-repo embeds those
fonts into the recorded page, verifies glyph coverage before launch, waits for
the browser font load, and shrinks each rendered caption only as far as the
declared minimum size and line count allow:

```js
captionOptions: {
  mode: 'focus',
  appearance: 'outline',
  typography: {
    locale: 'ko-KR',
    family: '"Campaign Sans", sans-serif',
    weight: 800,
    minFontSize: 28,
    maxFontSize: 44,
    maxLines: 2,
    fit: 'shrink',
    fonts: [{
      family: 'Campaign Sans',
      from: '.take-a-repo/fonts/campaign-sans.woff2',
      weight: '100 900',
    }],
  },
}
```

Font paths must remain inside the consumer project. OTF, TTF, WOFF, and WOFF2
files up to 24 MB are accepted, with at most four fallback faces. Focus chunks
use locale-aware word segmentation and preserve the authored punctuation and
separators, so Japanese and Chinese are not rebuilt with injected spaces.
Runtime QA reports missing glyphs, failed font loads, minimum-size overflow,
and severely unbalanced two-line captions as structured agent fixes. Existing
configs without `typography` retain their legacy system-font behavior.

Project-specific application plans stay repo-internal and are not included in
the npm package.

### CWS assets vs SNS demo clips

Chrome Web Store assets are inspection surfaces: crisp screenshots, promo tiles,
listing copy, and trademark-safe disclaimer bands. They should make the product
legible at store dimensions.

SNS demo clips are story surfaces: short, captioned walkthroughs that show the
result quickly, then the action and safety/restore path. For X demo video,
the `x` target applies 1280×720 H.264 automatically. The lower-level
`preset:'sns-video'` path remains available for legacy/custom captures. Use
`sns-twitter` (`1200×675`) for static X card images.

### Demo → mp4 / trim (SNS)

SNS uploaders (X, etc.) want H.264 mp4, not webm. Add `--mp4` (or configure it) and
take-a-repo post-processes the recording — silent H.264, `yuv420p`, `+faststart`:

```js
demo: {
  name: 'demo',
  preset: 'sns-video',
  mp4: true,                                // or { crf: 18 }
  trim: { start: 2, duration: '00:30' },    // optional; applied to the mp4
  zoom: { scale: 1.06 },                    // optional static center zoom
  thumbnail: { at: 1.2 },                   // writes demo-thumbnail.png
  async run({ page, env }) { /* … */ },
}
```

`trim` without `mp4` stream-copy-trims the webm in place. Requires a real
ffmpeg (`brew install ffmpeg` / `apt-get install -y ffmpeg`; GitHub ubuntu
runners have one; override with `TAKE_A_REPO_FFMPEG`) — Playwright's bundled
ffmpeg is vp8-only and can't encode H.264. If mp4/trim/crop/zoom/thumbnail is
requested and no ffmpeg is found, the run fails with the install hint rather
than skipping.

### Demo story controls

Captions render as a DOM overlay while Playwright records the page. The default
position is lower-left, with a translucent background, large text, safe padding,
and no collision with the top-left disclaimer badge.

Timed captions can use the built-in short-form focus treatment without speech
transcription. take-a-repo derives a deterministic synthetic word schedule from the authored
story, so silent product demos do not need Whisper, Python, or a second render
engine. `youtube-shorts` enables this automatically; custom and target-specific
captures can opt in or tune it directly:

```js
targetOptions: {
  'youtube-shorts': {
    captionOptions: {
      position: 'bottom-left',
      mode: 'focus',
      appearance: 'outline',
      wordsPerChunk: 3,
      wordMs: 360,
      activeColor: '#facc15',
      bottomOffset: 380,
    },
  },
}
```

`position` is intentionally limited to `bottom-left` and `bottom`. Set
`mode: 'static'` to disable focus sequencing; `appearance` independently
selects the `panel` or `outline` surface. The resolved style
is also written to `storyboard.json` and `captions.json`; the latter includes a
trim-relative `timeline[]` with rendered chunks, active-word indexes, and frame
boundaries for downstream agents. When authored beats are too close for the
requested pace, every word is preserved but storyboard lint returns
`dense-focus-caption` so the agent lengthens the beat before publishing.

Clicks made through `demo.click(selectorOrLocator)` show a high-contrast arrow
pointer and click ripple in the recording. Tune pacing with
`{ moveMs, beforeMs, holdMs }`, or turn it off with `{ highlight: false }`. A
Playwright Locator or `{ x, y }` point also works when selectors are awkward.

Native `<select>` popups are OS/browser UI and do not appear in Playwright's
page screencast. Use `demo.select()` so take-a-repo mirrors the element's real DOM
options inside the recorded page, shows the pointer, and then applies the real
selection:

```js
await demo.select('#language', 'ko', {
  moveMs: 550,
  openMs: 900,
  holdMs: 700,
});
```

Legacy/custom clips can use timed captions, the helper API, or both. Autonomous
channel targets must include timed `captions[]`: that authored schedule is the
handoff and retry contract, while helper calls remain immediate runtime callouts.

```js
demo: {
  name: 'demo',
  preset: 'sns-video',
  mp4: { crf: 18 },
  trim: { start: 0, duration: '00:35' },
  thumbnail: { at: 1.2 },
  zoom: { scale: 1.04 },
  captions: [
    { at: 0.5, text: 'Open the course page' },
    { at: 4.0, text: 'Translate visible lesson text' },
    { at: 11.0, text: 'Protected AI terms stay intact' },
    { at: 18.0, text: 'Restore the original anytime' },
  ],
  async run({ page, env, demo }) {
    await demo.step('Open the course page', async () => {
      await page.goto(`${env.baseUrl}/course`, { waitUntil: 'networkidle' });
    });
    await demo.step('Translate visible lesson text', async () => {
      await demo.click('[data-demo-translate]', { moveMs: 420, holdMs: 900 });
      await page.waitForSelector('[data-demo-translated="true"]');
    });
    await demo.caption('Restore the original anytime');
    await demo.select('#language', 'en');
    await demo.wait(900);
  },
}
```

Focus sequencing applies to timed `captions[]`. Direct `demo.caption()` and
`demo.step()` calls remain immediate full-phrase callouts so their existing
control-flow timing does not change. take-a-repo marks its caption and select
overlays as non-translatable so a product localization feature cannot rewrite
authored campaign copy.

Framing options are intentionally small:

```js
demo: {
  crop: { x: 120, y: 0, width: 1040, height: 720 }, // output a cropped mp4
  zoom: { scale: 1.08 },                            // center zoom, still 16:9
  thumbnail: { at: 1.5 },                           // poster frame
  storyboardLint: false,                            // legacy/short smoke clips only
}
```

Storyboard lint runs by default and logs warnings instead of failing the run.
The same warnings are written to `storyboard.json` with `code`, `severity`,
`message`, and `fix`, so an agent can revise `take-a-repo.config.js` on the next
pass. Current checks cover missing mp4, first caption after 3 seconds, odd video
dimensions, long captions, missing safety/restore beat, unsupported/offscreen
caption placement, crop/zoom edge risk, and clips outside the 20-40 second
target. During the real recording, take-a-repo also measures every scheduled
caption frame's bounding box, overflow, line count, computed outline stroke,
presence, timing drift, configured font load, fitted size, and line balance.
A mismatch becomes structured lint and prevents
`publish-ready`.
Autonomous channel targets require lint to remain enabled; setting
`storyboardLint:false` makes their automation status `needs-fix`.

For several campaign cuts, keep the old single `demo` field out and use
`demos: []`. Each entry writes `<name>.webm` and optional `<name>.mp4`, and
`--scene <name>` captures just that clip:

```js
demos: [
  {
    name: 'demo-translate',
    preset: 'sns-video',
    mp4: { crf: 18 },
    thumbnail: { at: 1.2 },
    trim: { start: 0, duration: '00:30' },
    captions: [
      { at: 0.5, text: 'Translate the lesson in place' },
      { at: 8.0, text: 'Protected terms stay safe' },
      { at: 18.0, text: 'Restore the original anytime' },
    ],
    async run({ page, env, demo }) { /* feature story */ },
  },
  {
    name: 'demo-restore',
    preset: 'sns-video',
    mp4: { crf: 18 },
    captions: [{ at: 0.5, text: 'Restore the original anytime' }],
    async run({ page, env, demo }) { /* safety story */ },
  },
]
```

Good demo stories stay 20-40 seconds, show a visible result in the first 3
seconds, follow before → action → result → safety/restore, keep captions short,
move cursor/click/typing actions slowly, and use mp4 for X.

### Agent contract (`--json`)

`take-a-repo [path] --json` prints **exactly one JSON object** to stdout (progress
logs move to stderr):

```json
{ "ok": true, "status": "awaiting-approval", "machineStatus": "publish-ready", "outDir": "/abs/store-assets", "manifest": "/abs/store-assets/take-a-repo-manifest.json", "produced": ["/abs/store-assets/skillbridge-x.mp4"] }
```

Exit codes: `0` ok · `1` runtime failure · `2` usage / no config found. Failure
payloads also use the single stdout JSON object (`{"ok":false,"error":…}`).
`ok:true` means execution completed. `machineStatus:publish-ready` means every
requested target passed take-a-repo's story lint, H.264/yuv420p, actual
dimensions, actual duration, thumbnail, nonblank-frame, integrity, and target
profile checks. Delivery `status` remains `awaiting-approval` until the user
reviews the media. It becomes `approved` only for that exact digest; a recapture
or profile change makes the decision stale. An authorized connector may publish
only when `handoff.approval.publishable` is true.
Drop-in agent wiring: the run-block in
[`AGENTS.md`](AGENTS.md) (read by Claude Code, Codex, Cursor, Gemini CLI, …) and
the [`skills/capture/`](skills/capture/SKILL.md) skill (Agent Skills format —
copy the folder into any compatible tool's skills directory).

## Config contract (`take-a-repo.config.js`)

```js
const { serveDirectory, stageExtension, patchManifestForLocalhost } = require('take-a-repo');

module.exports = {
  build: 'npm run build',                 // run first → real-bundle smoke test (optional)
  prepareExtension: () => '<unpacked dir>', // dir to --load-extension (often a patched temp copy)
  outDir: 'store-assets',
  disclaimer: 'Unofficial · not affiliated with …', // composited onto every shot (optional)
  description: { from: 'store-assets/STORE_LISTING.md' }, // → description.md (optional)
  // Or: { from: 'product.manifest.json', channel: 'chromeWebStore' }

  async setup({ context, extensionId, flags }) {  // e.g. start a fixture server / stubs
    return { env: { baseUrl }, teardown: async () => {} };
  },

  scenes: [
    { name: '01-feature', preset: 'cws-screenshot', caption: 'What this shows',
      async run({ page, context, extensionId, env, baseUrl, flags }) {
        await page.goto(`${env.baseUrl}/page`);  // drive the UI, wait until rendered
      } },
  ],

  promoTiles: [{ name: 'promo', template: 'path/to/promo.html', preset: 'cws-promo-small',
                 replacements: { NAME: 'My Ext' } }],

  // One story can render several channel variants automatically.
  demos: [
    { name: 'demo-feature', targets: ['cws-youtube', 'x', 'youtube-shorts'],
      captions: [
        { at: 0.5, text: 'Show the result first' },
        { at: 18.0, text: 'Restore the original anytime' },
      ],
      async run({ page, env, demo, target }) { /* reusable walkthrough */ } },
  ],
};
```

- A scene/tile takes a **`preset`** name or an explicit `{ width, height }` (see `PRESETS`).
- The harness reduces a captioned scene's capture height by the band height and stacks the band under it, so the final image is exactly the preset size and **no UI is hidden**.
- Demo captions are overlays inside the recorded page, not screenshot bands; they are meant for story clips, not CWS screenshots.
- Demo names must be unique across `demo` and `demos` because they become output filenames.
- Target demos expand to `<name>-<target>` filenames. Use `--target x` or
  `--scene <expanded-name>` for an automatic retry pass.

### Product manifest listing/privacy

Use `STORE_LISTING.md` when you want human-edited copy only. Use
`product.manifest.json` when listing copy, permission disclosures, and future
launch tooling should share one source of truth:

```js
module.exports = {
  description: { from: 'product.manifest.json', channel: 'chromeWebStore' },
};
```

Minimal manifest:

```json
{
  "product": {
    "name": "SkillBridge",
    "summary": "Translate selected text safely.",
    "description": "A browser extension for protected-term translation.",
    "category": "Productivity"
  },
  "stores": {
    "chromeWebStore": {
      "title": "SkillBridge Translator",
      "whatsNew": "- Rebuilt launch disclosures"
    }
  },
  "privacy": {
    "dataCollection": "No sale of personal data.",
    "dataUse": "Selected text is sent only when the user requests translation.",
    "permissions": [
      {
        "name": "storage",
        "purpose": "Save local preferences",
        "disclosure": "Stores settings on this device."
      }
    ],
    "dataFlows": [
      {
        "data": "Selected text",
        "source": "Active page",
        "destination": "Translation API",
        "purpose": "Return translated text",
        "retention": "Not retained by the extension"
      }
    ]
  }
}
```

`privacy-disclosure.md` is a review worksheet for store disclosure and README
permission tables. It is intentionally not a privacy policy generator.

## Public API

`require('take-a-repo')` →
`capture(config, opts)` · `serveDirectory` · `stageExtension` · `patchManifestForLocalhost` ·
`launchWithExtension` · `closeContext` · `compositeCaption` · `renderPromoTile` ·
`extractListing` · `extractProductManifest` · `renderDescriptionDoc` ·
`renderPrivacyDisclosureDoc` · `PRESETS` · `resolveSize` · `CHANNEL_PROFILES` ·
`resolveChannelProfile` · `buildPublishPlan` ·
`createDemoController` · `normalizeDemoConfigs` · `analyzeDemoStoryboard` ·
`lintDemoStoryboard` · `installDemoCaptionOverlay` · `setDemoCaption` ·
`buildVideoFilter` · `buildThumbnailArgs` · `HANDOFF_VERSION` ·
`HANDOFF_SCHEMA_IDS` · `buildHandoffDocs` · `writeHandoffDocs`.

## Roadmap — one engine, many surfaces

| Surface | Status | For |
|---|---|---|
| CLI (`take-a-repo`) with `--json` + `path` | ✅ now from source; `npx` after npm publication | humans / CI / **shell-having agents** |
| Programmatic `capture()` | ✅ now | embedding |
| Claude Code skill ([`skills/capture/`](skills/capture/SKILL.md)) | ✅ now | Claude Code (portable to Codex/Cursor/Gemini via the Agent Skills format) |
| `AGENTS.md` run-block | ✅ now | every agent that reads AGENTS.md |
| npm package (`take-a-repo`) | release target | `npx` zero-install after publish |
| Autonomous target rendering (`demo.targets`, CWS/YouTube, X, Shorts, ffprobe, pixel QA, retry actions) | ✅ now | publish-ready channel variants |
| Capture-in-CI GitHub Action | ✅ now — ships in [`browser-extension-starter`](https://github.com/starter-series/browser-extension-starter)'s `capture.yml` (headless) | zero-local-browser runs + CI smoke test |
| `starter-series` marketplace entry (`/plugin install take-a-repo@starter-series`) | ✅ now | discovery |
| General timeline/audio editing | non-goal | explicit `automation.manualFallback:true` only |

An MCP stdio tool was considered and **dropped** — see Non-goals: take-a-repo is a heavy, file-producing build tool, so a `--json` CLI + skill serves agents better than an MCP server's per-session context cost.

**Generalization rule** (for the next capability in the series): *one npm package (engine + thin CLI), one `*.config.js` contract for irreducible per-repo intent, agent surfaces matched to the tool's nature (fast/structured: an MCP tool taking a `path`; heavy/build-time: a `--json` CLI + skill + AGENTS.md run-block), one marketplace entry. The engine never reads project specifics except through the config contract.*

## License

[MIT](LICENSE) © heznpc
