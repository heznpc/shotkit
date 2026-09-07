/*
 * Scene spec for auto-generated demos.
 *
 * `--for` closed the mechanical layer the *channel* owns: viewport, codec,
 * duration cap. This module closes the layer the *clip* owns: how many beats a
 * clip has, in what order they play, and how each caption is worded.
 *
 * A zero-config demo reads its captions off the page, and raw page headings are
 * not a script. They are nav labels ("On this page"), duplicate section titles,
 * and sentence-length marketing copy. Left alone they produce clips whose rhythm
 * and caption style depend on the target's DOM, which is the opposite of a
 * consistent deliverable.
 *
 * planDemoScript() rewrites surveyed headings into one fixed shape —
 * open -> body beats in document order -> close, evenly paced, captions
 * normalized to the same length and punctuation rules the storyboard linter
 * uses. verifyDemoScript() then re-checks the plan against that shape, so
 * "regulation clip" is a measured claim rather than an assumption, the same way
 * verifyChannelOutputs() re-measures the delivered mp4.
 */

// Same ceiling the storyboard linter enforces (see demo-storyboard.js
// 'long-caption'), so an auto-generated clip cannot fail our own house rule.
const CAPTION_MAX_CHARS = 70;
const MAX_BODY_BEATS = 6;
// Park the heading just below the top edge instead of flush against it.
const HEADING_LEAD_RATIO = 0.15;

/*
 * Headings that describe the page's furniture rather than the product. These
 * are captions a human editor would always cut, so the spec cuts them too.
 */
const BOILERPLATE_HEADING = [
  /^(skip|jump)\s+to\b/i,
  /^(on\s+this\s+page|in\s+this\s+article|table\s+of\s+contents|contents)$/i,
  /^(menu|main\s+menu|navigation|nav|sidebar|footer|header|breadcrumbs?)$/i,
  /^(search|close|open|toggle|back|next|previous|more)$/i,
  /^(related|see\s+also|share\s+this|subscribe|newsletter|follow\s+us)$/i,
  /^(cookies?|cookie\s+settings|privacy|terms|legal|imprint)$/i,
  /^(목차|메뉴|검색|바로가기|본문\s*바로가기)$/,
];

/**
 * Apply the caption style rules: single line, no decorative list numbering, no
 * trailing sentence punctuation, and a hard length ceiling cut at a word
 * boundary rather than mid-word.
 *
 * @param {string} value
 * @param {number} [max]
 * @returns {string} normalized caption text ('' when nothing usable is left)
 */
function normalizeCaption(value, max = CAPTION_MAX_CHARS) {
  let text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // "1. Install", "02) Install", "- Install", "# Install" -> "Install"
  text = text.replace(/^[#\-–—*•]+\s*/, '').replace(/^\d{1,2}[.)]\s+/, '').trim();
  // A caption is a label, not a sentence.
  text = text.replace(/[.,;:!?]+$/u, '').trim();
  if (!text) return '';
  if (text.length <= max) return text;

  // Truncate at the last word boundary that leaves room for the ellipsis.
  const room = max - 1;
  const head = text.slice(0, room + 1);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(room * 0.5) ? head.slice(0, lastSpace) : text.slice(0, room);
  return `${cut.replace(/[.,;:!?\-–—]+$/u, '').trim()}\u2026`;
}

/**
 * @param {string} text  already normalized caption text
 * @returns {boolean} true when the heading is page furniture, not content
 */
function isBoilerplateHeading(text) {
  if (!text) return true;
  // A lone number or single glyph carries no meaning in a caption band.
  if (text.length < 2 || /^[\p{N}\p{P}\p{S}\s]+$/u.test(text)) return true;
  return BOILERPLATE_HEADING.some((pattern) => pattern.test(text));
}

function dedupeKey(text) {
  return text.toLowerCase().replace(/\u2026$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Turn a page survey into the fixed beat shape.
 *
 * The returned beats are the whole script: beat 0 opens on the page title,
 * body beats step down the page in document order (one per usable heading),
 * and the final beat returns to the top on the title. Pacing is even across
 * body beats so the rhythm does not depend on how the target is marked up.
 *
 * @param {object} survey
 * @param {string} survey.title
 * @param {Array<{text:string,top:number}>} [survey.headings]
 * @param {number} [survey.scrollHeight]
 * @param {number} [survey.viewportH]
 * @param {object} opts
 * @param {number} opts.durationS      clip budget in seconds
 * @param {number} opts.introHoldMs
 * @param {number} opts.outroHoldMs
 * @param {number} opts.minStepHoldMs
 * @param {number} [opts.maxBodyBeats]
 * @returns {{beats:Array<{role:string,text:string,scrollTop:number|null,holdMs:number}>,
 *           scrollable:number, bodyBeats:number, droppedHeadings:number}}
 */
function planDemoScript(survey, {
  durationS,
  introHoldMs,
  outroHoldMs,
  minStepHoldMs,
  maxBodyBeats = MAX_BODY_BEATS,
} = {}) {
  const viewportH = Number(survey && survey.viewportH) || 0;
  const scrollHeight = Number(survey && survey.scrollHeight) || 0;
  const scrollable = Math.max(0, scrollHeight - viewportH);
  const title = normalizeCaption(survey && survey.title) || 'Demo';
  const durationMs = Math.max(0, Number(durationS) || 0) * 1000;

  const seen = new Set([dedupeKey(title)]);
  let droppedHeadings = 0;
  const candidates = [];
  for (const heading of (survey && survey.headings) || []) {
    const text = normalizeCaption(heading && heading.text);
    const key = dedupeKey(text);
    // Boilerplate, a repeat of an earlier beat, or an echo of the title.
    if (isBoilerplateHeading(text) || seen.has(key)) {
      droppedHeadings++;
      continue;
    }
    seen.add(key);
    candidates.push({ text, top: Math.max(0, Number(heading && heading.top) || 0) });
  }
  // Scene order is document order, always — never DOM query order.
  candidates.sort((a, b) => a.top - b.top);

  const usable = scrollable >= 40
    ? candidates.filter((heading) => heading.top <= scrollHeight).slice(0, maxBodyBeats)
    : [];

  const budgetMs = Math.max(0, durationMs - introHoldMs - outroHoldMs);
  const beats = [{ role: 'open', text: title, scrollTop: null, holdMs: introHoldMs }];

  if (usable.length) {
    const holdMs = Math.max(minStepHoldMs, Math.floor(budgetMs / usable.length));
    const lead = Math.round(viewportH * HEADING_LEAD_RATIO);
    for (const heading of usable) {
      beats.push({
        role: 'body',
        text: heading.text,
        scrollTop: Math.max(0, Math.min(scrollable, Math.round(heading.top - lead))),
        holdMs,
      });
    }
    beats.push({ role: 'close', text: title, scrollTop: 0, holdMs: outroHoldMs });
  } else {
    // Single-screen page, or a page whose headings were all furniture: hold the
    // loaded state instead of inventing beats the page cannot support.
    beats[0].holdMs = durationMs;
  }

  return {
    beats,
    scrollable,
    bodyBeats: usable.length,
    droppedHeadings,
  };
}

/**
 * Re-check a planned script against the spec. Anything reported here is a real
 * deviation from the fixed shape, not a style preference.
 *
 * @param {{beats:Array<object>}} script  from planDemoScript()
 * @param {object} [opts]
 * @param {number} [opts.maxChars]
 * @returns {{ok:boolean, beats:number, captions:number, problems:string[]}}
 */
function verifyDemoScript(script, { maxChars = CAPTION_MAX_CHARS } = {}) {
  const problems = [];
  const beats = (script && Array.isArray(script.beats)) ? script.beats : [];
  if (!beats.length) problems.push('script has no beats');

  const keys = new Set();
  let lastScrollTop = -1;
  beats.forEach((beat, index) => {
    const label = `beat ${index + 1}`;
    if (!beat || typeof beat.text !== 'string' || !beat.text.trim()) {
      problems.push(`${label} has no caption text`);
      return;
    }
    if (beat.text.length > maxChars) {
      problems.push(`${label} caption is ${beat.text.length} chars, over the ${maxChars} limit`);
    }
    if (beat.text !== beat.text.replace(/\s+/g, ' ').trim()) {
      problems.push(`${label} caption is not a single normalized line`);
    }
    if (beat.role === 'body') {
      const key = dedupeKey(beat.text);
      if (keys.has(key)) problems.push(`${label} repeats an earlier caption: "${beat.text}"`);
      keys.add(key);
      if (beat.scrollTop != null && beat.scrollTop < lastScrollTop) {
        problems.push(`${label} scrolls back up to ${beat.scrollTop} — scene order must move down the page`);
      }
      if (beat.scrollTop != null) lastScrollTop = beat.scrollTop;
    }
    if (!Number.isFinite(beat.holdMs) || beat.holdMs <= 0) {
      problems.push(`${label} has no hold time`);
    }
  });

  if (beats.length > 1) {
    if (beats[0].role !== 'open') problems.push('script does not start on an open beat');
    if (beats[beats.length - 1].role !== 'close') problems.push('script does not end on a close beat');
  }

  return {
    ok: problems.length === 0,
    beats: beats.length,
    captions: beats.filter((beat) => beat && beat.text).length,
    problems,
  };
}

module.exports = {
  CAPTION_MAX_CHARS,
  MAX_BODY_BEATS,
  isBoilerplateHeading,
  normalizeCaption,
  planDemoScript,
  verifyDemoScript,
};
