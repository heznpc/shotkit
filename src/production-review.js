const fs = require('fs');
const path = require('path');
const { digest } = require('./evidence-contract');
const { readJsonIfExists, safeAssetPath, sha256File, writeJson } = require('./handoff-files');
const { selectedObservationFrames } = require('./production-frames');
const { readProject, withProjectLock } = require('./production-project');
const { editorialContract, REVIEW_CRITERIA, validateEditorialBrief } = require('./editorial');

function contextDigest(context) {
  return digest(JSON.stringify({ reviewDigest: context.reviewDigest, deliverable: context.deliverable,
    from: context.range.from, to: context.range.to, width: context.width, crop: context.crop, frames: context.frames }));
}

function reviewStatus(report, runDir, reviewDigest) {
  if (!report.editorialReviewRequired) return { status: 'not-required', authority: 'agent-review-only' };
  const review = readJsonIfExists(path.join(runDir, 'editorial-review.json'));
  const videos = report.deliverables.filter((d) => d.kind === 'video');
  if (!review || review.reviewDigest !== reviewDigest || !Array.isArray(review.deliverables) || review.deliverables.length !== videos.length
    || videos.some((d) => !review.deliverables.some((r) => r?.id === d.id))) return { status: 'pending', authority: 'agent-review-only' };
  const valid = review.deliverables.every((d) => Array.isArray(d.checks) && d.checks.length === REVIEW_CRITERIA.length
    && REVIEW_CRITERIA.every((criterion) => d.checks.some((check) => check?.criterion === criterion && ['pass', 'fail'].includes(check.status)
      && typeof check.reason === 'string' && check.reason.trim() && Array.isArray(check.frames) && check.frames.length)));
  if (!valid) return { status: 'pending', authority: 'agent-review-only' };
  const passed = review.deliverables.every((d) => d.checks.every((check) => check.status === 'pass'));
  return { status: passed ? 'reviewed' : 'changes-requested', authority: 'agent-review-only', reviewDigest, path: path.join(runDir, 'editorial-review.json'), findings: review.deliverables };
}

function candidate(config, opts) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const outDir = path.resolve(cwd, config.outDir || 'product-evidence');
  const state = require('./evidence-state').evidenceState(outDir);
  if (state.machineStatus !== 'publish-ready' || state.problems?.length || !state.scope?.full) throw new Error('review requires a current intact technically ready candidate');
  return { cwd, outDir, state };
}

function reviewTimes(spec, duration, from, to, budget, timeline = []) {
  const times = new Set([from, Math.max(from, to - 1 / 30)]);
  const add = (at) => { if (at >= from && at < to && at < duration) times.add(Math.round(at * 30) / 30); };
  for (const item of [...(spec.editorial?.beats || []), ...(spec.captions || [])]) {
    add(item.start - 1 / 30); add(item.start + 1 / 30); add(item.end - 1 / 30); add(item.end + 1 / 30);
  }
  for (const caption of spec.captions || []) for (const cue of caption.focusCues || []) {
    add(caption.start + cue.at); add(caption.start + cue.at + 1 / 6);
  }
  for (const frame of timeline) {
    add(frame.at - 1 / 30); add(frame.at + 1 / 6);
  }
  for (let i = 1; i < budget; i++) add(from + (to - from) * i / budget);
  const all = [...times].filter((at) => at >= from && at < to && at < duration).sort((a, b) => a - b);
  return all.length <= budget ? all : Array.from({ length: budget }, (_, i) => all[Math.round(i * (all.length - 1) / (budget - 1))]);
}

function reviewContext(config, opts = {}) {
  const { outDir, state } = candidate(config, opts);
  const videos = state.report.deliverables.filter((d) => d.kind === 'video');
  const spec = opts.deliverable ? videos.find((d) => d.id === opts.deliverable) : videos.length === 1 ? videos[0] : null;
  if (!spec) throw new Error('review-context requires a configured --deliverable when there is more than one video');
  const asset = state.report.files.find((f) => f.id === spec.id && f.mediaType === 'video/mp4' && spec.files.includes(f.path));
  if (!asset) throw new Error('final composited video is unavailable');
  const duration = asset.qa.durationSeconds;
  const { from = 0, to = duration, maxFrames = 16, width = Math.min(1920, asset.qa.width), crop = null } = opts;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > duration || from >= to
    || !Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > 32) throw new Error('invalid review range or frame budget');
  if (crop && (crop.x + crop.width > asset.qa.width || crop.y + crop.height > asset.qa.height)) throw new Error('review crop is outside final video');
  const video = safeAssetPath(state.runDir, { outPath: asset.path });
  const timelineAsset = state.report.files.find((f) => f.id === `${spec.id}-captions` && f.role === 'caption-timeline');
  const timelineFile = timelineAsset && safeAssetPath(state.runDir, { outPath: timelineAsset.path });
  const timeline = timelineFile ? readJsonIfExists(timelineFile)?.frames : [];
  if (!Array.isArray(timeline)) throw new Error('final caption timeline is invalid; rerender the candidate');
  const frames = selectedObservationFrames(video, outDir, { times: reviewTimes(spec, duration, from, to, maxFrames, timeline), width, crop });
  const contextId = digest(JSON.stringify({ reviewDigest: state.reviewDigest, deliverable: spec.id, from, to, width, crop, frames }));
  const context = {
    version: 1, kind: 'take-a-repo.editorial-context', authority: 'observation-only', contextId,
    reviewDigest: state.reviewDigest, deliverable: spec.id, video: { path: video, sha256: asset.sha256, durationSeconds: duration },
    range: { from, to, timebase: 'output-seconds', sourceOffset: spec.trim?.start || 0 }, width, crop,
    coverage: { completeEventCoverage: false, uncoveredBeats: (spec.editorial?.beats || []).filter((beat) => frames.filter((f) => f.atSeconds >= beat.start && f.atSeconds < beat.end).length < 2).map((b) => b.id) },
    frames, editorial: spec.editorial || null, captions: spec.captions || [], captionTimeline: timeline.filter((f) => f.at < to && (f.endAt ?? duration) > from), captionOptions: require('./production-render').resolvedCaptionOptions(spec), protectedRegions: spec.protectedRegions || [],
    editContext: { baseRevision: readProject(outDir)?.revision || null }, authoring: editorialContract(),
    reviewContract: { reviewDigest: state.reviewDigest, deliverables: [{ id: spec.id, contexts: [contextId], checks: REVIEW_CRITERIA.map((criterion) => ({ criterion, status: 'pass|fail', reason: 'Observed result, timestamp and repair if needed', frames: ['frame ID actually inspected'] })) }] },
    next: 'Watch the linked final video, inspect these full frames and request additional ranges/crops as needed. Reference inspected frames in all five checks. Record a production review --report JSON; passing records an agent judgement only. Repair failures with production edit and run. Only then present media for user approval.',
  };
  const root = safeAssetPath(outDir, { outPath: 'editorial-contexts' });
  if (!root) throw new Error('unsafe editorial context directory');
  fs.mkdirSync(root, { recursive: true });
  const file = safeAssetPath(root, { outPath: `${contextId}.json` });
  if (!file) throw new Error('unsafe editorial context path');
  if (require('./evidence-state').evidenceState(outDir).reviewDigest !== state.reviewDigest) throw new Error('candidate changed during review extraction');
  writeJson(file, context);
  return context;
}

async function recordEditorialReview(config, review, opts = {}) {
  const outDir = path.resolve(opts.cwd || process.cwd(), config.outDir || 'product-evidence');
  return withProjectLock(outDir, async () => {
    if (fs.existsSync(path.join(outDir, '.take-a-repo.lock'))) throw new Error('capture output is locked');
    const { state } = candidate(config, opts);
    const videos = state.report.deliverables.filter((d) => d.kind === 'video');
    if (!review || Object.keys(review).some((k) => !['reviewDigest', 'deliverables'].includes(k))
      || review.reviewDigest !== state.reviewDigest || !Array.isArray(review.deliverables)
      || review.deliverables.length !== videos.length || new Set(review.deliverables.map((d) => d.id)).size !== videos.length) throw new Error('review must cover every current video and its exact candidate digest');
    for (const entry of review.deliverables) {
      const spec = videos.find((d) => d.id === entry.id);
      if (!spec || Object.keys(entry).some((k) => !['id', 'contexts', 'checks'].includes(k))
        || !Array.isArray(entry.contexts) || !entry.contexts.length || entry.contexts.length > 40) throw new Error('review needs bounded contexts for each deliverable');
      const frames = entry.contexts.flatMap((id) => {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid review context ID');
        const file = safeAssetPath(outDir, { outPath: `editorial-contexts/${id}.json` });
        const context = file && readJsonIfExists(file);
        if (!context || context.reviewDigest !== state.reviewDigest || context.deliverable !== entry.id || context.contextId !== id || contextDigest(context) !== id) throw new Error('stale, changed or missing review context');
        return context.frames.map((frame) => {
          const file = safeAssetPath(outDir, { outPath: path.relative(outDir, frame.path) });
          if (!file || sha256File(file) !== frame.sha256) throw new Error('review frame changed');
          return { ...frame, fullFrame: !context.crop };
        });
      });
      if (!Array.isArray(entry.checks) || entry.checks.length !== REVIEW_CRITERIA.length
        || new Set(entry.checks.map((c) => c.criterion)).size !== REVIEW_CRITERIA.length) throw new Error('review requires all five distinct editorial criteria');
      for (const check of entry.checks) {
        if (Object.keys(check).some((k) => !['criterion', 'status', 'reason', 'frames'].includes(k))
          || !REVIEW_CRITERIA.includes(check.criterion) || !['pass', 'fail'].includes(check.status)
          || typeof check.reason !== 'string' || !check.reason.trim() || check.reason.length > 2000
          || !Array.isArray(check.frames) || !check.frames.length || check.frames.length > 128
          || check.frames.some((id) => !frames.some((frame) => frame.id === id))) throw new Error('each review check needs a supported verdict, an observed reason and inspected frame references');
      }
      if (entry.checks.every((c) => c.status === 'pass')) {
        if (!spec.editorial) throw new Error('author the editorial brief before passing an editorial review');
        const asset = state.report.files.find((f) => f.id === spec.id && f.mediaType === 'video/mp4');
        validateEditorialBrief(spec.editorial, asset?.qa.durationSeconds);
        const inspected = new Set(entry.checks.flatMap((check) => check.frames));
        if (spec.editorial.beats.some((beat) => new Set(frames.filter((f) => inspected.has(f.id) && f.fullFrame && f.atSeconds >= beat.start && f.atSeconds < beat.end).map((f) => f.atSeconds)).size < 2)) throw new Error('inspect at least two full frames per beat; request more review-context ranges');
      }
    }
    const record = { ...review, authority: 'agent-review-only', recordedAt: new Date().toISOString() };
    writeJson(path.join(state.runDir, 'editorial-review.json'), record);
    return reviewStatus(state.report, state.runDir, state.reviewDigest);
  });
}

module.exports = { reviewStatus, reviewContext, recordEditorialReview, reviewTimes };
