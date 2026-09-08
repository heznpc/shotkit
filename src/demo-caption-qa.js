const MAX_CAPTION_TIMING_DRIFT_MS = 240;

function warning(code, message, fix, details) {
  return {
    code,
    severity: 'warning',
    message,
    fix,
    ...(details ? { details } : {}),
  };
}

function viewportFor(sample, fallback) {
  return sample.viewport && Number.isFinite(sample.viewport.width) && Number.isFinite(sample.viewport.height)
    ? sample.viewport
    : fallback;
}

function transformedRect(rect, viewport, framing) {
  if (!rect || !viewport || !framing || !Number.isFinite(framing.scale) || framing.scale <= 1) return rect;
  const scale = framing.scale;
  const focusX = Number.isFinite(framing.focusX) ? framing.focusX : 0.5;
  const focusY = Number.isFinite(framing.focusY) ? framing.focusY : 0.5;
  const cropWidth = viewport.width / scale;
  const cropHeight = viewport.height / scale;
  const cropX = (viewport.width - cropWidth) * focusX;
  const cropY = (viewport.height - cropHeight) * focusY;
  return {
    left: (rect.left - cropX) * scale,
    top: (rect.top - cropY) * scale,
    right: (rect.right - cropX) * scale,
    bottom: (rect.bottom - cropY) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

function overlaps(first, second) {
  return first && second
    && first.left < second.x + second.width
    && first.right > second.x
    && first.top < second.y + second.height
    && first.bottom > second.y;
}

function analyzeDemoCaptionMetrics(report = {}, { viewport, protectedRegions = [], framing = null } = {}) {
  const expectedFrames = Array.isArray(report.expectedFrames) ? report.expectedFrames : [];
  const samples = Array.isArray(report.samples) ? report.samples : [];
  const warnings = [];
  const warned = new Set();
  const warnOnce = (code, message, fix, details) => {
    if (warned.has(code)) return;
    warned.add(code);
    warnings.push(warning(code, message, fix, details));
  };
  const typography = report.typography && report.typography.enabled ? report.typography : null;
  if (typography) {
    if (typography.locale === 'und') {
      warnOnce(
        'caption-locale-missing',
        'caption typography does not declare a locale',
        'set captionOptions.typography.locale to the authored caption language',
      );
    }
    if (!typography.deterministic) {
      warnOnce(
        'caption-font-not-embedded',
        'caption typography relies on environment-specific system fonts',
        'configure one or more project-local captionOptions.typography.fonts',
      );
    }
    if (Array.isArray(typography.missingGlyphs) && typography.missingGlyphs.length) {
      warnOnce(
        'caption-missing-glyph',
        `configured caption fonts miss ${typography.missingGlyphs.length} authored character(s)`,
        'add a locale-appropriate fallback font that covers every listed code point',
        { missingGlyphs: typography.missingGlyphs },
      );
    }
  }

  for (const sample of samples) {
    const sampleViewport = viewportFor(sample, viewport);
    const rect = transformedRect(sample.rect, sampleViewport, framing);
    if (sampleViewport && rect && (
      rect.left < -1
      || rect.top < -1
      || rect.right > sampleViewport.width + 1
      || rect.bottom > sampleViewport.height + 1
    )) {
      warnOnce(
        'caption-outside-viewport',
        `caption "${sample.sourceText || sample.text}" renders outside the viewport`,
        'use a supported caption position and reduce captionOptions.bottomOffset',
        { rect, viewport: sampleViewport },
      );
    }
    if (sample.overflowX || sample.overflowY) {
      warnOnce(
        'caption-overflow',
        `caption "${sample.sourceText || sample.text}" overflows its rendered box`,
        'shorten the caption or use smaller authored chunks',
        { overflowX: !!sample.overflowX, overflowY: !!sample.overflowY },
      );
    }
    if (typography && sample.fontLoaded === false) {
      warnOnce(
        'caption-font-load-failed',
        `caption font failed to load for "${sample.sourceText || sample.text}"`,
        'verify the configured font file and rerun the target',
        { errors: sample.fontErrors || [] },
      );
    }
    if (typography && ((sample.fontConfigured === false && typography.deterministic !== false) || sample.fitStatus === 'not-requested')) {
      warnOnce(
        'caption-typography-not-applied',
        `configured caption typography was not applied to "${sample.sourceText || sample.text}"`,
        'preserve the prepared caption options across pointer, select, and navigation helpers, then rerun the target',
      );
    }
    if (typography && sample.fitStatus === 'overflow') {
      warnOnce(
        'caption-type-fit-failed',
        `caption "${sample.sourceText || sample.text}" does not fit at the configured minimum size`,
        'shorten the authored chunk, widen its template lane, or lower typography.minFontSize',
        {
          fontSize: sample.fontSize,
          minFontSize: sample.minFontSize,
          lineCount: sample.lineCount,
          maxLines: sample.maxLines,
        },
      );
    }
    if (typography && sample.lineCount > 1 && Number.isFinite(sample.lineBalance)
      && sample.lineBalance < typography.minLineBalance) {
      warnOnce(
        'caption-unbalanced-lines',
        `caption "${sample.sourceText || sample.text}" has an unbalanced final line`,
        'split the caption at a semantic boundary or adjust the template caption width',
        { lineWidths: sample.lineWidths, lineBalance: sample.lineBalance, minimum: typography.minLineBalance },
      );
    }
    if (sample.lineCount > 2) {
      warnOnce(
        'caption-too-many-lines',
        `caption "${sample.sourceText || sample.text}" renders on ${sample.lineCount} lines`,
        'shorten the caption or split it into semantic chunks of at most two lines',
        { lineCount: sample.lineCount },
      );
    }
    if (sample.appearance === 'outline' && sample.strokeWidth < 1) {
      warnOnce(
        'caption-outline-missing',
        `outline caption "${sample.sourceText || sample.text}" rendered without a visible stroke`,
        'restore the outline preset stroke or switch this caption to panel appearance',
        { strokeWidth: sample.strokeWidth },
      );
    }
    const collision = protectedRegions.find((region) => overlaps(rect, region));
    if (collision) {
      warnOnce(
        'caption-protected-region-overlap',
        `caption "${sample.sourceText || sample.text}" overlaps protected region "${collision.label || collision.id}"`,
        'move the caption lane, reduce zoom, or choose a layout preset that keeps the protected UI clear',
        { rect, region: collision },
      );
    }
  }

  for (const region of protectedRegions) {
    if (viewport && (
      region.x < 0
      || region.y < 0
      || region.x + region.width > viewport.width
      || region.y + region.height > viewport.height
    )) {
      warnOnce(
        'protected-region-outside-viewport',
        `protected region "${region.label || region.id}" extends outside the viewport`,
        'resize or move the protected region inside the target canvas',
        { region, viewport },
      );
    }
  }

  const scheduledSamples = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample.expectedAtMs) || scheduledSamples.has(sample.expectedAtMs)) continue;
    scheduledSamples.set(sample.expectedAtMs, sample);
  }
  const missingFrames = expectedFrames.filter((frame) => !scheduledSamples.has(frame.atMs));
  if (missingFrames.length) {
    warnings.push(warning(
      'caption-frame-missing',
      `${missingFrames.length} scheduled caption frame(s) were not observed in the recorded page`,
      'move the first caption later or remove navigation and long tasks from its scheduled window',
      { frames: missingFrames },
    ));
  }

  const drifts = expectedFrames.flatMap((frame) => {
    const sample = scheduledSamples.get(frame.atMs);
    return sample ? [{
      expectedAtMs: frame.atMs,
      actualAtMs: sample.actualAtMs,
      driftMs: Math.max(0, sample.actualAtMs - frame.atMs),
      text: frame.text,
    }] : [];
  });
  const slowestFrame = drifts.reduce((slowest, frame) => (
    !slowest || frame.driftMs > slowest.driftMs ? frame : slowest
  ), null);
  const maximumDriftMs = slowestFrame ? slowestFrame.driftMs : 0;
  if (maximumDriftMs > MAX_CAPTION_TIMING_DRIFT_MS) {
    warnings.push(warning(
      'caption-timing-drift',
      `caption rendering drift reached ${maximumDriftMs}ms`,
      'move the affected caption later or finish navigation before its scheduled time',
      { maximumDriftMs, limitMs: MAX_CAPTION_TIMING_DRIFT_MS, frame: slowestFrame },
    ));
  }

  return warnings;
}

module.exports = {
  MAX_CAPTION_TIMING_DRIFT_MS,
  analyzeDemoCaptionMetrics,
  transformedRect,
};
