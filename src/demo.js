/*
 * take-a-repo — demo story helpers.
 *
 * Demo videos are recorded from the real page, so captions are rendered as a
 * lightweight DOM overlay during Playwright recording. The helper object passed
 * to config.demo.run keeps configs small: caption → action → short hold.
 */

const DEFAULT_CLICK_HOLD_MS = 500;
const DEFAULT_CLICK_MOVE_MS = 360;
const DEFAULT_CLICK_BEFORE_MS = 120;
const DEFAULT_STEP_HOLD_MS = 800;

const { normalizeDelayMs, normalizeDemoCaptions, parseTimeToMs } = require('./demo-time');
const { buildCaptionFrames, captionStyle } = require('./demo-caption-focus');
const { analyzeDemoStoryboard, formatStoryboardLint, lintDemoStoryboard } = require('./demo-storyboard');
const { expandDemoTargets } = require('./channels');
const { hideDemoSelect, installDemoSelectOverlay, performDemoSelect } = require('./demo-select');

function normalizeDemoConfigs(config = {}) {
  const demos = [];
  if (config.demo) demos.push(config.demo);
  if (config.demos != null) {
    if (!Array.isArray(config.demos)) throw new Error('take-a-repo: config.demos must be an array');
    demos.push(...config.demos);
  }

  const validated = demos.map((demo, index) => {
    if (!demo || typeof demo !== 'object') {
      throw new Error(`take-a-repo: demo entry ${index} must be an object`);
    }
    if (!demo.name) throw new Error(`take-a-repo: demo entry ${index} needs a name`);
    if (typeof demo.run !== 'function') throw new Error(`take-a-repo: demo "${demo.name}" needs run({ page, demo })`);
    if (demo.captions != null && !Array.isArray(demo.captions)) {
      throw new Error(`take-a-repo: demo "${demo.name}".captions must be an array`);
    }
    return demo;
  });
  const expanded = validated.flatMap(expandDemoTargets);
  const seen = new Set();
  for (const demo of expanded) {
    if (seen.has(demo.name)) throw new Error(`take-a-repo: duplicate demo name "${demo.name}"`);
    seen.add(demo.name);
  }
  return expanded;
}

function demoCaptionInitScript(options = {}) {
  // Keep motion inside this serialized initializer. Live capture and offline
  // rendering share it, and the public initializer remains standalone.
  function createCaptionMotion(root) {
    let visible = root.dataset.visible === 'true';
    let position = root.dataset.position || 'bottom-left';
    let rootMotion = null;
    let wordMotion = null;
    const transform = (offset) => position === 'bottom'
      ? `translate(-50%, ${offset}px)` : `translateY(${offset}px)`;
    const now = (atMs) => Number.isFinite(atMs) ? atMs : performance.now();
    const motions = () => [rootMotion, wordMotion].filter(Boolean);

    function seek(atMs) {
      const at = now(atMs);
      for (const item of motions()) {
        item.animation.pause();
        item.animation.currentTime = Math.max(0, at - item.atMs);
      }
      return {
        visible,
        remainingMs: Math.max(0, ...motions().map((item) => item.atMs + item.duration - at)),
      };
    }

    function animate(element, keyframes, duration, easing, atMs, paused) {
      const animation = element.animate(keyframes, { duration, easing, fill: 'both' });
      if (paused) {
        animation.pause();
        animation.currentTime = 0;
      }
      return { animation, atMs, duration };
    }

    function visibility(nextVisible, { atMs, paused = false } = {}) {
      const at = now(atMs);
      if (paused) seek(at);
      const nextPosition = root.dataset.position || 'bottom-left';
      if (visible === nextVisible && position === nextPosition) return;
      const computed = window.getComputedStyle(root);
      const opacity = computed.opacity;
      const previousTransform = computed.transform;
      rootMotion?.animation.cancel();
      position = nextPosition;
      visible = nextVisible;
      root.dataset.visible = visible ? 'true' : 'false';
      rootMotion = animate(root, [
        { opacity, transform: previousTransform === 'none' ? transform(visible ? 8 : 0) : previousTransform },
        { opacity: visible ? 1 : 0, transform: transform(visible ? 0 : 8) },
      ], 160, 'ease', at, paused);
    }

    function word(element, { atMs, paused = false, appearance = 'panel' } = {}) {
      wordMotion?.animation.cancel();
      wordMotion = null;
      if (!element) return;
      wordMotion = animate(element, [
        { offset: 0, opacity: .55, transform: 'translateY(4px) scale(.94)', easing: 'cubic-bezier(.2,.9,.3,1.2)' },
        { offset: .7, opacity: 1, transform: 'translateY(-1px) scale(1.04)', easing: 'cubic-bezier(.2,.9,.3,1.2)' },
        { offset: 1, opacity: 1, transform: 'translateY(0) scale(1)' },
      ], appearance === 'outline' ? 230 : 180, 'linear', now(atMs), paused);
    }

    return { seek, visibility, word };
  }
  const rootId = '__take-a-repo_demo_caption__';
  const pointerId = '__take-a-repo_demo_pointer__';
  const styleId = '__take-a-repo_demo_caption_style__';
  const baseOptions = {
    position: options.position || 'bottom-left',
    typography: options.typography && typeof options.typography === 'object'
      ? options.typography
      : { enabled: false },
  };
  let fontLoadPromise = null;
  let motion = null;
  let showRequest = 0;
  let lastMeasurement = null;

  function loadCaptionFonts() {
    const faces = Array.isArray(baseOptions.typography.fontFaces)
      ? baseOptions.typography.fontFaces
      : [];
    if (!faces.length) return Promise.resolve({ configured: false, loaded: true, errors: [] });
    if (fontLoadPromise) return fontLoadPromise;
    fontLoadPromise = (async () => {
      const startedAt = performance.now();
      if (typeof FontFace !== 'function' || !document.fonts) {
        return { configured: true, loaded: false, loadMs: 0, errors: ['FontFace API is unavailable'] };
      }
      const results = await Promise.allSettled(faces.map(async (face) => {
        const loaded = await new FontFace(face.family, `url(${face.source})`, {
          weight: face.weight || '400',
          style: face.style || 'normal',
        }).load();
        document.fonts.add(loaded);
        return face.family;
      }));
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => String(result.reason && result.reason.message ? result.reason.message : result.reason));
      return {
        configured: true,
        loaded: errors.length === 0,
        loadMs: Math.round(performance.now() - startedAt),
        errors,
      };
    })();
    return fontLoadPromise;
  }

  function ensureStyle() {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #${rootId} {
        position: fixed;
        z-index: 2147483646;
        box-sizing: border-box;
        max-width: min(760px, calc(100vw - 56px));
        padding: 13px 17px 14px;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 8px;
        background: rgba(13,17,23,.88);
        color: #fff;
        box-shadow: 0 16px 42px rgba(0,0,0,.28);
        font: 700 24px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        letter-spacing: 0;
        text-wrap: balance;
        pointer-events: none;
        opacity: 0;
        transform: translateY(8px);
      }
      #${rootId}[data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }
      #${rootId}[data-mode="focus"] {
        width: min(660px, calc(100vw - 56px));
        min-height: 78px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        column-gap: 0;
        row-gap: .08em;
        padding: 14px 22px 16px;
        background: rgba(8,11,16,.86);
        font-size: 32px;
        font-weight: 800;
        line-height: 1.15;
        text-align: center;
        overflow-wrap: anywhere;
      }
      #${rootId}[data-mode="focus"][data-condensed="true"] {
        font-size: 26px;
        line-height: 1.18;
      }
      #${rootId}[data-appearance="outline"] {
        min-height: 0;
        padding: 5px 0 7px;
        border: 0;
        background: transparent;
        color: #fff;
        box-shadow: none;
        -webkit-text-stroke: 2px rgba(7,10,15,.92);
        paint-order: stroke fill;
        text-shadow: 0 2px 0 rgba(0,0,0,.58), 0 6px 12px rgba(0,0,0,.26);
      }
      #${rootId}[data-mode="focus"][data-appearance="outline"] {
        font-size: 40px;
        font-weight: 900;
        line-height: 1.08;
      }
      #${rootId}[data-mode="focus"][data-appearance="outline"][data-condensed="true"] {
        font-size: 32px;
      }
      #${rootId}[data-appearance="outline"] .take-a-repo-caption-word {
        color: #fff;
        -webkit-text-stroke: 2px rgba(7,10,15,.92);
        paint-order: stroke fill;
        text-shadow: inherit;
      }
      #${rootId}[data-appearance="outline"] .take-a-repo-caption-word[data-active="true"] {
        color: var(--take-a-repo-caption-active-color, #facc15);
        text-shadow: 0 2px 0 rgba(0,0,0,.62), 0 6px 13px rgba(0,0,0,.3);
      }
      #${rootId} .take-a-repo-caption-word {
        display: inline-block;
        color: rgba(255,255,255,.72);
        transform-origin: center bottom;
        white-space: pre-wrap;
      }
      #${rootId} .take-a-repo-caption-word::before { content: attr(data-before); }
      #${rootId} .take-a-repo-caption-word::after { content: attr(data-after); }
      #${rootId} .take-a-repo-caption-word[data-active="true"] {
        color: var(--take-a-repo-caption-active-color, #facc15);
        text-shadow: 0 2px 14px rgba(0,0,0,.52);
      }
      #${rootId}[data-position="bottom-left"] {
        left: max(28px, env(safe-area-inset-left));
        bottom: max(var(--take-a-repo-caption-bottom-offset, 26px), env(safe-area-inset-bottom));
      }
      #${rootId}[data-position="bottom"] {
        left: 50%;
        bottom: max(var(--take-a-repo-caption-bottom-offset, 26px), env(safe-area-inset-bottom));
        transform: translate(-50%, 8px);
        text-align: center;
      }
      #${rootId}[data-position="bottom"][data-visible="true"] {
        transform: translate(-50%, 0);
      }
      @media (max-width: 720px) {
        #${rootId} {
          max-width: calc(100vw - 36px);
          padding: 11px 14px 12px;
          font-size: 20px;
        }
        #${rootId}[data-position="bottom-left"] {
          left: max(18px, env(safe-area-inset-left));
          bottom: max(var(--take-a-repo-caption-bottom-offset, 18px), env(safe-area-inset-bottom));
        }
        #${rootId}[data-position="bottom"] {
          bottom: max(var(--take-a-repo-caption-bottom-offset, 18px), env(safe-area-inset-bottom));
        }
        #${rootId}[data-mode="focus"] {
          width: calc(100vw - 220px);
          max-width: 500px;
          min-height: 88px;
          padding: 15px 18px 17px;
          font-size: 34px;
        }
        #${rootId}[data-mode="focus"][data-position="bottom-left"] {
          left: max(48px, env(safe-area-inset-left));
        }
        #${rootId}[data-mode="focus"][data-position="bottom"] {
          width: calc(100vw - 96px);
          max-width: 660px;
        }
        #${rootId}[data-mode="focus"][data-condensed="true"] {
          font-size: 25px;
        }
        #${rootId}[data-mode="focus"][data-appearance="outline"] {
          font-size: 42px;
        }
        #${rootId}[data-mode="focus"][data-appearance="outline"][data-condensed="true"] {
          font-size: 32px;
        }
      }
      #${pointerId} {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483647;
        width: 44px;
        height: 52px;
        margin: -9px 0 0 -9px;
        background: radial-gradient(circle at 9px 9px, rgba(37,99,235,.42) 0 8px, rgba(37,99,235,.14) 9px 17px, transparent 18px);
        pointer-events: none;
        opacity: 0;
        transform: translate(-120px, -120px);
        transition-property: transform, opacity;
        transition-duration: 360ms, 120ms;
        transition-timing-function: cubic-bezier(.2,.8,.2,1), ease;
      }
      #${pointerId}[data-visible="true"] {
        opacity: 1;
      }
      #${pointerId}::before {
        content: "";
        position: absolute;
        left: 6px;
        top: 5px;
        width: 28px;
        height: 38px;
        background: #fff;
        clip-path: polygon(0 0, 0 78%, 29% 62%, 50% 100%, 75% 91%, 53% 57%, 100% 57%);
        filter: drop-shadow(-2px -1px 0 #0f172a) drop-shadow(2px 2px 0 #0f172a) drop-shadow(0 5px 5px rgba(0,0,0,.35));
        transform-origin: 8px 8px;
        transition: transform 90ms ease;
      }
      #${pointerId}[data-clicking="true"]::before {
        transform: translate(1px, 1px) scale(.92);
      }
      #${pointerId}::after {
        content: "";
        position: absolute;
        left: -12px;
        top: -12px;
        width: 42px;
        height: 42px;
        border: 3px solid rgba(37,99,235,.42);
        border-radius: 999px;
        opacity: 0;
        transform: scale(.6);
      }
      #${pointerId}[data-clicking="true"]::after {
        animation: take-a-repo-click-ripple 520ms ease-out;
      }
      @keyframes take-a-repo-click-ripple {
        0% { opacity: .95; transform: scale(.6); }
        100% { opacity: 0; transform: scale(1.9); }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureRoot() {
    if (!document.body) return null;
    ensureStyle();
    let root = document.getElementById(rootId);
    if (!root) {
      root = document.createElement('div');
      root.id = rootId;
      root.className = 'notranslate';
      root.setAttribute('translate', 'no');
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.dataset.position = baseOptions.position;
      document.body.appendChild(root);
    }
    if (!motion) motion = createCaptionMotion(root);
    return root;
  }

  function ensurePointer() {
    if (!document.body) return null;
    ensureStyle();
    let pointer = document.getElementById(pointerId);
    if (!pointer) {
      pointer = document.createElement('div');
      pointer.id = pointerId;
      document.body.appendChild(pointer);
    }
    return pointer;
  }

  function captionLines(root) {
    const words = Array.from(root.querySelectorAll('.take-a-repo-caption-word'));
    const rects = words.length
      ? words.map((word) => ({
        top: word.offsetTop,
        left: word.offsetLeft,
        right: word.offsetLeft + word.offsetWidth,
        width: word.offsetWidth,
        height: word.offsetHeight,
      }))
      : (() => {
        const range = document.createRange();
        range.selectNodeContents(root);
        return Array.from(range.getClientRects());
      })();
    const lines = [];
    for (const rect of rects.filter((item) => item.width > 0 && item.height > 0)) {
      let line = lines.find((item) => Math.abs(item.top - rect.top) <= 2);
      if (!line) {
        line = { top: rect.top, left: rect.left, right: rect.right };
        lines.push(line);
      } else {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
      }
    }
    return lines.sort((first, second) => first.top - second.top)
      .map((line) => Math.max(0, line.right - line.left));
  }

  function captionMeasure(root) {
    const lineWidths = captionLines(root);
    const widest = lineWidths.length ? Math.max(...lineWidths) : 0;
    const narrowest = lineWidths.length ? Math.min(...lineWidths) : 0;
    return {
      overflowX: root.scrollWidth > root.clientWidth + 1,
      overflowY: root.scrollHeight > root.clientHeight + 1,
      lineCount: lineWidths.length,
      lineWidths: lineWidths.map((width) => Math.round(width * 100) / 100),
      lineBalance: lineWidths.length > 1 && widest > 0 ? narrowest / widest : 1,
    };
  }

  function fitCaption(root, typography) {
    const computed = window.getComputedStyle(root);
    const cssSize = Number.parseFloat(computed.fontSize) || 24;
    const maximum = Number.isFinite(typography.maxFontSize) ? typography.maxFontSize : Math.round(cssSize);
    const minimum = Math.min(maximum, Number.isFinite(typography.minFontSize) ? typography.minFontSize : maximum);
    const maxLines = Number.isInteger(typography.maxLines) ? typography.maxLines : 2;
    const setSize = (size) => {
      root.style.fontSize = `${size}px`;
      const measured = captionMeasure(root);
      return {
        ...measured,
        fontSize: size,
        fits: !measured.overflowX && !measured.overflowY && measured.lineCount <= maxLines,
      };
    };

    if (!typography.enabled) {
      const measured = captionMeasure(root);
      return {
        ...measured,
        requestedFontSize: cssSize,
        fontSize: cssSize,
        minFontSize: null,
        maxLines,
        fitStatus: 'not-requested',
      };
    }
    if (typography.fit !== 'shrink') {
      const measured = setSize(maximum);
      return {
        ...measured,
        requestedFontSize: maximum,
        minFontSize: minimum,
        maxLines,
        fitStatus: measured.fits ? 'fit' : 'overflow',
      };
    }

    let low = minimum;
    let high = maximum;
    let best = null;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const measured = setSize(size);
      if (measured.fits) {
        best = measured;
        low = size + 1;
      } else {
        high = size - 1;
      }
    }
    const measured = best || setSize(minimum);
    if (best) root.style.fontSize = `${best.fontSize}px`;
    return {
      ...measured,
      requestedFontSize: maximum,
      minFontSize: minimum,
      maxLines,
      fitStatus: measured.fits ? 'fit' : 'overflow',
    };
  }

  async function show(text, nextOptions = {}) {
    if (!text) {
      hide(nextOptions);
      return null;
    }
    const request = ++showRequest;
    const fontState = await loadCaptionFonts();
    // A slow font load must not replay an earlier scheduled phrase over a newer one.
    if (request !== showRequest) return null;
    const root = ensureRoot();
    if (!root) return null;
    const position = nextOptions.position || baseOptions.position;
    const typography = baseOptions.typography && baseOptions.typography.enabled
      ? { ...baseOptions.typography, ...(nextOptions.typography || {}) }
      : { enabled: false };
    root.dataset.position = position;
    root.dataset.mode = nextOptions.mode === 'focus' ? 'focus' : 'static';
    root.dataset.appearance = nextOptions.appearance === 'outline' ? 'outline' : 'panel';
    root.dataset.condensed = nextOptions.condensed || (!typography.enabled
      && root.dataset.mode === 'focus' && String(text).length > 42) ? 'true' : 'false';
    if (typography.enabled) {
      root.lang = nextOptions.locale || typography.locale || 'und';
      root.dir = nextOptions.direction || typography.direction || 'ltr';
      root.style.fontFamily = typography.family;
      if (typography.weight) root.style.fontWeight = typography.weight;
      else root.style.removeProperty('font-weight');
    } else {
      root.removeAttribute('lang');
      root.removeAttribute('dir');
      root.style.removeProperty('font-family');
      root.style.removeProperty('font-weight');
    }
    // Each phrase starts from its declared preset, not a previous phrase's
    // pinned/shrunk inline size. Otherwise one long caption shrinks later ones.
    root.style.removeProperty('font-size');
    if (Number.isFinite(nextOptions.bottomOffset) && nextOptions.bottomOffset >= 0) {
      root.style.setProperty('--take-a-repo-caption-bottom-offset', `${Math.round(nextOptions.bottomOffset)}px`);
    } else {
      root.style.removeProperty('--take-a-repo-caption-bottom-offset');
    }
    root.style.setProperty('--take-a-repo-caption-active-color', nextOptions.activeColor || '#facc15');
    root.textContent = '';
    if (root.dataset.mode === 'focus' && (Array.isArray(nextOptions.focusSegments)
      || Array.isArray(nextOptions.focusWords))) {
      const segments = Array.isArray(nextOptions.focusSegments)
        ? nextOptions.focusSegments
        : nextOptions.focusWords.map((word, index, words) => ({
          before: '',
          text: word,
          after: index === words.length - 1 ? '' : ' ',
        }));
      segments.forEach((segment, index) => {
        // Use an element most page translators do not scan. The root's
        // translate=no marker covers standards-aware localization tools too.
        const wordElement = document.createElement('b');
        wordElement.className = 'take-a-repo-caption-word';
        wordElement.dataset.active = index === nextOptions.activeWordIndex ? 'true' : 'false';
        wordElement.dataset.before = String(segment.before || '');
        wordElement.dataset.after = String(segment.after || '');
        wordElement.textContent = String(segment.text);
        root.appendChild(wordElement);
      });
      root.setAttribute('aria-label', String(nextOptions.fullText || text));
      root.setAttribute('aria-live', 'off');
    } else {
      root.textContent = String(text);
      root.removeAttribute('aria-label');
      root.setAttribute('aria-live', 'polite');
    }
    // Production intervals may pin a font size; the same measurement path
    // applies in live capture and offline composition.
    if (Number.isFinite(nextOptions.fontSize)) root.style.fontSize = `${nextOptions.fontSize}px`;
    const fit = fitCaption(root, Number.isFinite(nextOptions.fontSize) && typography.enabled
      ? { ...typography, maxFontSize: nextOptions.fontSize } : typography);
    const motionOptions = { atMs: nextOptions.motionAtMs, paused: nextOptions.motionPaused === true, appearance: root.dataset.appearance };
    motion.visibility(true, motionOptions);
    motion.word(root.querySelector('.take-a-repo-caption-word[data-active="true"]'), motionOptions);

    const rect = root.getBoundingClientRect();
    const rootStyle = window.getComputedStyle(root);
    const firstWord = root.querySelector('.take-a-repo-caption-word');
    const textStyle = firstWord ? window.getComputedStyle(firstWord) : rootStyle;
    const stroke = textStyle.webkitTextStrokeWidth
      || textStyle.getPropertyValue('-webkit-text-stroke-width')
      || '0';
    lastMeasurement = {
      text: String(text),
      sourceText: String(nextOptions.fullText || text),
      renderedAt: Date.now(),
      mode: root.dataset.mode,
      appearance: root.dataset.appearance,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: fit.overflowX,
      overflowY: fit.overflowY,
      lineCount: fit.lineCount,
      lineWidths: fit.lineWidths,
      lineBalance: fit.lineBalance,
      fitStatus: fit.fitStatus,
      fontSize: fit.fontSize,
      requestedFontSize: fit.requestedFontSize,
      minFontSize: fit.minFontSize,
      maxLines: fit.maxLines,
      locale: typography.enabled ? root.lang : null,
      direction: typography.enabled ? root.dir : null,
      fontConfigured: fontState.configured,
      fontLoaded: fontState.configured ? fontState.loaded : null,
      fontLoadMs: Number.isFinite(fontState.loadMs) ? fontState.loadMs : null,
      fontErrors: fontState.errors,
      fontFamily: rootStyle.fontFamily,
      strokeWidth: Number.parseFloat(stroke) || 0,
    };
    return measurement();
  }

  function hide(nextOptions = {}) {
    showRequest++;
    const root = ensureRoot();
    if (root) motion.visibility(false, { atMs: nextOptions.motionAtMs, paused: nextOptions.motionPaused === true });
  }

  function measurement() {
    const root = ensureRoot();
    if (!root || !lastMeasurement) return null;
    // Transformed active words can extend beyond their layout boxes at the pop
    // peak. Measure those pixels too when checking the viewport/protected UI.
    const rects = [root.getBoundingClientRect(), ...Array.from(root.querySelectorAll('.take-a-repo-caption-word'), (word) => word.getBoundingClientRect())];
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { ...lastMeasurement, rect: { left, top, right, bottom, width: right - left, height: bottom - top } };
  }

  function seek(atMs) {
    const root = ensureRoot();
    return root ? { ...motion.seek(atMs), measurement: measurement() } : null;
  }

  function movePointer(point, nextOptions = {}) {
    const pointer = ensurePointer();
    if (!pointer) return;
    const durationMs = nextOptions.durationMs == null ? 360 : nextOptions.durationMs;
    pointer.style.transitionDuration = `${durationMs}ms, 120ms`;
    pointer.style.transform = `translate(${point.x}px, ${point.y}px)`;
    pointer.dataset.visible = 'true';
  }

  function pulsePointer() {
    const pointer = ensurePointer();
    if (!pointer) return;
    pointer.dataset.clicking = 'false';
    void pointer.offsetWidth;
    pointer.dataset.clicking = 'true';
    window.setTimeout(() => {
      if (pointer.dataset.clicking === 'true') pointer.dataset.clicking = 'false';
    }, 560);
  }

  function hidePointer() {
    const pointer = ensurePointer();
    if (pointer) pointer.dataset.visible = 'false';
  }

  window.__takeARepoDemoCaption = { show, hide, seek, measurement, ready: loadCaptionFonts };
  window.__takeARepoDemoPointer = { move: movePointer, pulse: pulsePointer, hide: hidePointer };
  void loadCaptionFonts();
  const install = () => ensureRoot();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}

async function installDemoCaptionOverlay(context, options = {}) {
  await context.addInitScript(demoCaptionInitScript, options);
  await installDemoSelectOverlay(context);
}

async function ensureDemoCaptionOverlay(page, options = {}) {
  await page.evaluate(demoCaptionInitScript, options);
}

async function renderDemoCaption(page, text, options = {}) {
  return page.evaluate(
    ({ captionText, captionOptions }) => {
      return window.__takeARepoDemoCaption.show(captionText, captionOptions);
    },
    {
      captionText: String(text),
      captionOptions: options,
    },
  );
}

async function setDemoCaption(page, text, options = {}) {
  await ensureDemoCaptionOverlay(page, options);
  return renderDemoCaption(page, text, options);
}

async function hideDemoCaption(page) {
  await page.evaluate(() => {
    if (window.__takeARepoDemoCaption) window.__takeARepoDemoCaption.hide();
  });
}

function hasDemoPointerOverlay() {
  return !!window.__takeARepoDemoPointer;
}

async function moveDemoPointer(page, point, options = {}) {
  const installed = await page.evaluate(hasDemoPointerOverlay).catch(() => false);
  if (!installed) await ensureDemoCaptionOverlay(page);
  await page.evaluate(
    ({ pointerPoint, pointerOptions }) => {
      window.__takeARepoDemoPointer.move(pointerPoint, pointerOptions);
    },
    { pointerPoint: point, pointerOptions: options },
  );
}

async function pulseDemoPointer(page) {
  await page.evaluate(() => {
    if (window.__takeARepoDemoPointer) window.__takeARepoDemoPointer.pulse();
  });
}

async function hideDemoPointer(page) {
  await page.evaluate(() => {
    if (window.__takeARepoDemoPointer) window.__takeARepoDemoPointer.hide();
  });
}

function isPoint(target) {
  return target && Number.isFinite(target.x) && Number.isFinite(target.y);
}

async function targetCenter(page, target) {
  if (isPoint(target)) return { x: Math.round(target.x), y: Math.round(target.y) };

  let box = null;
  if (target && typeof target.boundingBox === 'function') {
    box = await target.boundingBox().catch(() => null);
  } else if (typeof target === 'string' && typeof page.locator === 'function') {
    box = await page.locator(target).boundingBox().catch(() => null);
  }
  if (!box && typeof target === 'string' && typeof page.$eval === 'function') {
    box = await page.$eval(target, (el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }).catch(() => null);
  }
  if (!box) return null;
  return { x: Math.round(box.x + (box.width / 2)), y: Math.round(box.y + (box.height / 2)) };
}

async function clickTarget(page, target, clickOptions) {
  if (typeof target === 'string') return page.click(target, clickOptions);
  if (target && typeof target.click === 'function') return target.click(clickOptions);
  if (isPoint(target) && page.mouse && typeof page.mouse.click === 'function') {
    return page.mouse.click(target.x, target.y, clickOptions);
  }
  throw new Error('take-a-repo: demo.click target must be a selector string, Locator, or { x, y } point');
}

function createDemoController({
  page,
  captions = [],
  captionOptions = {},
  runtimeCaptionOptions = captionOptions,
  typographyReport = null,
}) {
  const schedule = normalizeDemoCaptions(captions);
  const captionFrames = buildCaptionFrames(schedule, captionOptions);
  let hasAuthoredCaptions = captionFrames.some((frame) => frame.text);
  const timers = [];
  const captionSamples = [];
  const startedAt = Date.now();
  let activeText = '';
  let activeOptions = {};
  let activeExpectedAtMs = null;
  let overlayReady = false;
  let stopped = false;

  async function render(text, options = {}, expectedAtMs = null) {
    if (stopped) return;
    activeText = String(text || '');
    if (activeText) hasAuthoredCaptions = true;
    activeOptions = options || {};
    activeExpectedAtMs = expectedAtMs;
    const authoredOptions = { ...captionOptions, ...activeOptions };
    const nextOptions = { ...runtimeCaptionOptions, ...activeOptions };
    captionStyle(authoredOptions);
    try {
      if (activeText) {
        if (!overlayReady) {
          await ensureDemoCaptionOverlay(page, nextOptions);
          overlayReady = true;
        }
        const sample = await renderDemoCaption(page, activeText, nextOptions);
        if (sample) {
          const { renderedAt, ...metrics } = sample;
          captionSamples.push({
            ...metrics,
            expectedAtMs,
            actualAtMs: Number.isFinite(renderedAt)
              ? Math.max(0, Math.round(renderedAt - startedAt))
              : Date.now() - startedAt,
          });
        }
      }
      else await hideDemoCaption(page);
    } catch (_e) {
      overlayReady = false;
      // Navigations can briefly destroy the execution context. The next helper
      // call or DOMContentLoaded replay will render the latest caption.
    }
  }

  const replay = () => {
    if (!activeText || stopped) return;
    overlayReady = false;
    setTimeout(() => render(activeText, activeOptions, activeExpectedAtMs), 0);
  };
  page.on('domcontentloaded', replay);

  for (const frame of captionFrames) {
    timers.push(setTimeout(() => render(frame.text, frame.options, frame.atMs), frame.atMs));
  }

  return {
    caption: (text, options = {}) => render(text, options),

    async step(text, action, options = {}) {
      // Caption display options may be passed explicitly (captionOptions) or flat
      // (e.g. step(text, fn, { position }) by analogy with caption()); honor both
      // so they are not silently dropped. holdMs is the only step-control key.
      const { holdMs, captionOptions, ...displayOptions } = options;
      await render(text, { ...displayOptions, ...(captionOptions || {}) });
      const result = typeof action === 'function' ? await action() : undefined;
      const hold = normalizeDelayMs(holdMs == null ? DEFAULT_STEP_HOLD_MS : holdMs, 'step holdMs');
      if (hold > 0) await page.waitForTimeout(hold);
      return result;
    },

    wait(ms) {
      return page.waitForTimeout(normalizeDelayMs(ms, 'wait ms'));
    },

    async select(target, value, options = {}) {
      return performDemoSelect({
        page,
        target,
        value,
        options,
        targetCenter,
        movePointer: moveDemoPointer,
        pulsePointer: pulseDemoPointer,
      });
    },

    async click(target, options = {}) {
      const {
        holdMs = DEFAULT_CLICK_HOLD_MS,
        moveMs = DEFAULT_CLICK_MOVE_MS,
        beforeMs = DEFAULT_CLICK_BEFORE_MS,
        highlight = true,
        ...clickOptions
      } = options;
      const normalizedMoveMs = normalizeDelayMs(moveMs, 'click moveMs');
      const normalizedBeforeMs = normalizeDelayMs(beforeMs, 'click beforeMs');
      const normalizedHoldMs = normalizeDelayMs(holdMs, 'click holdMs');
      const point = highlight ? await targetCenter(page, target) : null;
      if (point) {
        await moveDemoPointer(page, point, { durationMs: normalizedMoveMs });
        if (normalizedMoveMs + normalizedBeforeMs > 0) {
          await page.waitForTimeout(normalizedMoveMs + normalizedBeforeMs);
        }
      }
      await clickTarget(page, target, clickOptions);
      if (point) await pulseDemoPointer(page);
      if (normalizedHoldMs > 0) await page.waitForTimeout(normalizedHoldMs);
    },

    async hide() {
      await render('');
      await hideDemoPointer(page).catch(() => {});
      await hideDemoSelect(page).catch(() => {});
    },

    hidePointer() {
      return hideDemoPointer(page);
    },

    captionMetrics() {
      return {
        captionState: hasAuthoredCaptions ? 'burned-in' : 'none',
        expectedFrames: captionFrames.map((frame) => ({ atMs: frame.atMs, text: frame.text })),
        samples: captionSamples.map((sample) => ({ ...sample, rect: { ...sample.rect } })),
        typography: typographyReport ? { ...typographyReport } : null,
      };
    },

    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      page.off('domcontentloaded', replay);
    },
  };
}

module.exports = {
  DEFAULT_CLICK_HOLD_MS,
  DEFAULT_CLICK_BEFORE_MS,
  DEFAULT_CLICK_MOVE_MS,
  DEFAULT_STEP_HOLD_MS,
  analyzeDemoStoryboard,
  createDemoController,
  demoCaptionInitScript,
  ensureDemoCaptionOverlay,
  formatStoryboardLint,
  hideDemoCaption,
  hideDemoPointer,
  installDemoCaptionOverlay,
  lintDemoStoryboard,
  moveDemoPointer,
  normalizeDelayMs,
  normalizeDemoConfigs,
  normalizeDemoCaptions,
  parseTimeToMs,
  pulseDemoPointer,
  setDemoCaption,
  targetCenter,
};
