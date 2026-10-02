const Ajv = require('ajv');
const schema = require('../schemas/production-project.schema.json');

const CAPTION_ROLES = schema.definitions.caption.properties.role.enum;
const CAPTION_FIELDS = ['role', 'focusChunks', 'focusCues'];
const EDIT_FIELDS = ['trim', 'crop', 'zoom', 'thumbnail', 'captions', 'captionOptions', 'protectedRegions', 'editorial'];
const EDIT_PATHS = [
  ...EDIT_FIELDS,
  ...Object.keys(schema.definitions.captionStyleEdit.properties).map((key) => `captionOptions.${key}`),
  ...Object.keys(schema.definitions.typographyEdit.properties).map((key) => `captionOptions.typography.${key}`),
];
const REVIEW_CRITERIA = ['evidence', 'composition', 'legibility', 'pacing', 'continuity'];
const validate = new Ajv({ allErrors: true }).compile(schema.definitions.editorial);
const GUIDANCE = 'State the audience and one viewer takeaway. For each beat, identify the visible subject, expected change, attention order and why its hold is needed. Bind beats to output time ranges; inspect the corresponding source before asserting a change. Keep a short complete caption visible together using focusChunks:[caption.text]; retain the Shorts animation by highlighting every word in reading order without replacing the sentence. Omit focusCues for automatic wordMs timing; use cues only to adjust timing while preserving every word highlight. Never replace sequential focus with agent-selected important words. Never separate a modifier from the noun it describes or split one proposition merely to meet a word count. If it does not fit, measure wrapping or font size within the declared bounds, or rewrite the complete caption. Use multiple temporal chunks only for independently readable statements with a specific editorial reason. Use word:null only after the complete phrase has been highlighted to let the viewer inspect the product. Choose a stable caption lane using the actual composition and protected UI. Technical geometry, pixels and keywords cannot judge meaning. Inspect the final composited video at beat/phrase transitions and at native scale, record timestamped findings for evidence, composition, legibility, pacing and continuity, repair them, then present the exact candidate to the user. An agent review is not user approval.';

function validateEditorialBrief(brief, duration = Infinity) {
  if (brief === undefined) return;
  if (!validate(brief)) throw new Error(`invalid editorial brief: ${JSON.stringify(validate.errors)}`);
  if (['objective', 'audience', 'rationale'].some((key) => !brief[key].trim())) throw new Error('editorial intent cannot be blank');
  const ids = new Set();
  let previousEnd = 0;
  for (const beat of brief.beats) {
    if (ids.has(beat.id) || beat.end <= beat.start || beat.end > duration
      || Math.abs(beat.start - previousEnd) > 1 / 30
      || ['subject', 'expectedChange', 'attention', 'holdReason'].some((key) => !beat[key].trim())) {
      throw new Error('editorial beats require unique IDs, meaningful direction and consecutive ranges covering the edited video');
    }
    ids.add(beat.id);
    previousEnd = beat.end;
  }
  if (Number.isFinite(duration) && Math.abs(previousEnd - duration) > 1 / 30) throw new Error('editorial beats must cover the full edited duration, including holds');
}

function editorialContract() {
  return {
    version: 1, authority: 'authoring-intent-not-verified-evidence',
    guidance: GUIDANCE, editableFields: EDIT_FIELDS, unsetPaths: EDIT_PATHS, captionFields: Object.keys(schema.definitions.caption.properties),
    editSemantics: 'set replaces fields and arrays; captionOptions and typography keys merge. unset removes only saved overrides at the listed paths, restoring config defaults. reset:true clears all overrides for one deliverable. trim/crop/zoom:null disables that configured operation; thumbnail:null restores channel thumbnail timing.',
    timebase: 'output-seconds', cueTimebase: 'seconds-from-caption-start',
    reviewCriteria: REVIEW_CRITERIA,
    briefSchema: schema.definitions.editorial,
    captionSchema: schema.definitions.caption,
    example: { objective: 'Show a visible result', audience: 'Intended viewer', rationale: 'Why this cut serves the request',
      beats: [{ id: 'result', role: 'result', start: 0, end: 3, subject: 'Changed product region', expectedChange: 'Observable before/after difference', attention: 'Result first, then explanation', holdReason: 'Time to inspect the changed values' }] },
  };
}

module.exports = { CAPTION_ROLES, CAPTION_FIELDS, EDIT_FIELDS, EDIT_PATHS, REVIEW_CRITERIA, GUIDANCE, validateEditorialBrief, editorialContract };
