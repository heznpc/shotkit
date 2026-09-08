const fs = require('fs');
const path = require('path');
const fontkit = require('fontkit');
const subsetFont = require('subset-font');

const { canonicalLocale, textDirection } = require('./caption-language');

const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_EXTENSIONS = new Set(['.otf', '.ttf', '.woff', '.woff2']);
const MAX_FONT_BYTES = 24 * 1024 * 1024;
const MAX_FONTS = 4;
const TYPOGRAPHY_KEYS = new Set([
  'locale', 'direction', 'family', 'weight', 'minFontSize', 'maxFontSize',
  'maxLines', 'fit', 'minLineBalance', 'fonts',
]);
const FONT_KEYS = new Set(['family', 'from', 'weight', 'style', 'postscriptName']);

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`take-a-repo: ${name} must be a non-empty string`);
  return value.trim();
}

function boundedNumber(value, fallback, name, min, max, integer = false) {
  const resolved = value == null ? fallback : value;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max || (integer && !Number.isInteger(resolved))) {
    throw new Error(`take-a-repo: caption typography.${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return resolved;
}

function fontWeight(value, name) {
  if (value == null) return null;
  if (Number.isInteger(value) && value >= 1 && value <= 1000) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`take-a-repo: ${name} must be a font weight or variable weight range`);
}

function normalizeFont(font, index) {
  if (!isObject(font)) throw new Error(`take-a-repo: caption typography.fonts[${index}] must be an object`);
  const unknown = Object.keys(font).filter((key) => !FONT_KEYS.has(key));
  if (unknown.length) {
    throw new Error(`take-a-repo: caption typography.fonts[${index}] has unknown field(s): ${unknown.join(', ')}`);
  }
  const style = font.style == null ? 'normal' : font.style;
  if (!['normal', 'italic', 'oblique'].includes(style)) {
    throw new Error(`take-a-repo: caption typography.fonts[${index}].style must be normal, italic, or oblique`);
  }
  return {
    family: nonEmptyString(font.family, `caption typography.fonts[${index}].family`),
    from: nonEmptyString(font.from, `caption typography.fonts[${index}].from`),
    weight: fontWeight(font.weight, `caption typography.fonts[${index}].weight`) || '400',
    style,
    ...(font.postscriptName == null ? {} : {
      postscriptName: nonEmptyString(font.postscriptName, `caption typography.fonts[${index}].postscriptName`),
    }),
  };
}

function quotedFamily(family) {
  return `"${family.replace(/["\\]/g, '\\$&')}"`;
}

function normalizeTypographyOptions(captionOptions = {}) {
  const raw = captionOptions && captionOptions.typography;
  if (raw == null) {
    return {
      enabled: false,
      locale: 'und',
      direction: 'ltr',
      family: SYSTEM_FONT_STACK,
      weight: null,
      minFontSize: 18,
      maxFontSize: null,
      maxLines: 2,
      fit: 'none',
      minLineBalance: 0,
      fonts: [],
    };
  }
  if (!isObject(raw)) throw new Error('take-a-repo: caption typography must be an object');
  const unknown = Object.keys(raw).filter((key) => !TYPOGRAPHY_KEYS.has(key));
  if (unknown.length) throw new Error(`take-a-repo: caption typography has unknown field(s): ${unknown.join(', ')}`);
  const locale = canonicalLocale(raw.locale);
  const direction = textDirection(locale, raw.direction || 'auto');
  const fonts = raw.fonts == null ? [] : raw.fonts;
  if (!Array.isArray(fonts) || fonts.length > MAX_FONTS) {
    throw new Error(`take-a-repo: caption typography.fonts must be an array with at most ${MAX_FONTS} entries`);
  }
  const normalizedFonts = fonts.map(normalizeFont);
  const family = raw.family == null
    ? (normalizedFonts.length
      ? `${normalizedFonts.map((font) => quotedFamily(font.family)).join(', ')}, ${SYSTEM_FONT_STACK}`
      : SYSTEM_FONT_STACK)
    : nonEmptyString(raw.family, 'caption typography.family');
  const unreferencedFonts = raw.family == null
    ? []
    : normalizedFonts.filter((font) => !family.toLowerCase().includes(font.family.toLowerCase()));
  if (unreferencedFonts.length) {
    throw new Error(`take-a-repo: caption typography.family must reference configured font family: ${unreferencedFonts.map((font) => font.family).join(', ')}`);
  }
  const fit = raw.fit == null ? 'shrink' : raw.fit;
  if (!['none', 'shrink'].includes(fit)) throw new Error('take-a-repo: caption typography.fit must be "none" or "shrink"');
  const minFontSize = boundedNumber(raw.minFontSize, 22, 'minFontSize', 12, 96, true);
  const maxFontSize = raw.maxFontSize == null
    ? null
    : boundedNumber(raw.maxFontSize, null, 'maxFontSize', minFontSize, 120, true);
  return {
    enabled: true,
    locale,
    direction,
    family,
    weight: fontWeight(raw.weight, 'caption typography.weight'),
    minFontSize,
    maxFontSize,
    maxLines: boundedNumber(raw.maxLines, 2, 'maxLines', 1, 3, true),
    fit,
    minLineBalance: boundedNumber(raw.minLineBalance, 0.38, 'minLineBalance', 0, 1),
    fonts: normalizedFonts,
  };
}

function typographyStyle(captionOptions = {}) {
  const typography = normalizeTypographyOptions(captionOptions);
  if (!typography.enabled) return null;
  return {
    locale: typography.locale,
    direction: typography.direction,
    family: typography.family,
    ...(typography.weight == null ? {} : { weight: typography.weight }),
    minFontSize: typography.minFontSize,
    ...(typography.maxFontSize == null ? {} : { maxFontSize: typography.maxFontSize }),
    maxLines: typography.maxLines,
    fit: typography.fit,
    minLineBalance: typography.minLineBalance,
    fontFamilies: typography.fonts.map((font) => font.family),
  };
}

function fontMime(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.otf': return 'font/otf';
    case '.ttf': return 'font/ttf';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function fontPath(cwd, from) {
  const root = fs.realpathSync(cwd);
  const requested = path.resolve(root, from);
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch (error) {
    throw new Error(`take-a-repo: caption font was not found: ${from}`, { cause: error });
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('take-a-repo: caption typography font paths must stay inside the project directory');
  }
  if (!FONT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`take-a-repo: unsupported caption font format: ${path.extname(resolved) || '(none)'}`);
  }
  const stats = fs.statSync(resolved);
  if (!stats.isFile() || stats.size > MAX_FONT_BYTES) {
    throw new Error(`take-a-repo: caption font must be a file no larger than ${MAX_FONT_BYTES} bytes`);
  }
  return resolved;
}

function relevantCharacters(texts) {
  const characters = new Map();
  for (const text of texts || []) {
    for (const character of String(text)) {
      const codePoint = character.codePointAt(0);
      if (/\s/u.test(character) || codePoint === 0x200d
        || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
        || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) continue;
      if (!characters.has(codePoint)) characters.set(codePoint, character);
    }
  }
  return characters;
}

function codePointLabel(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

async function prepareCaptionTypography(captionOptions = {}, cwd, texts = []) {
  const typography = normalizeTypographyOptions(captionOptions);
  if (!typography.enabled) {
    return {
      runtimeOptions: captionOptions,
      report: { enabled: false, deterministic: false, locale: 'und', direction: 'ltr' },
    };
  }

  const characters = relevantCharacters(texts);
  const prepared = await Promise.all(typography.fonts.map(async (font) => {
    const resolved = fontPath(cwd, font.from);
    const buffer = fs.readFileSync(resolved);
    let parsed;
    try {
      parsed = fontkit.create(buffer, font.postscriptName);
    } catch (error) {
      throw new Error(`take-a-repo: could not parse caption font ${font.from}: ${error.message}`, { cause: error });
    }
    if (!parsed || typeof parsed.hasGlyphForCodePoint !== 'function') {
      throw new Error(`take-a-repo: caption font ${font.from} needs postscriptName for its font collection`);
    }
    const subsetText = ` ${Array.from(characters)
      .filter(([codePoint]) => parsed.hasGlyphForCodePoint(codePoint))
      .map(([, character]) => character)
      .join('')}`;
    let embedded = buffer;
    if (characters.size) {
      const numericWeight = typography.weight && /^\d+$/u.test(typography.weight)
        ? Number(typography.weight)
        : null;
      const variationAxes = numericWeight != null && parsed.variationAxes && parsed.variationAxes.wght
        ? { wght: numericWeight }
        : undefined;
      try {
        embedded = await subsetFont(buffer, subsetText, {
          targetFormat: 'woff2',
          ...(variationAxes ? { variationAxes } : {}),
        });
      } catch (error) {
        throw new Error(`take-a-repo: could not subset caption font ${font.from}: ${error.message}`, { cause: error });
      }
    }
    return {
      ...font,
      resolved,
      parsed,
      sourceBytes: buffer.length,
      embeddedBytes: embedded.length,
      source: `data:${characters.size ? 'font/woff2' : fontMime(resolved)};base64,${embedded.toString('base64')}`,
    };
  }));
  const missingGlyphs = [];
  for (const [codePoint, character] of characters) {
    if (prepared.length && !prepared.some((font) => font.parsed.hasGlyphForCodePoint(codePoint))) {
      missingGlyphs.push({ character, codePoint: codePointLabel(codePoint) });
    }
  }
  const publicStyle = typographyStyle(captionOptions);
  const fontFaces = prepared.map((font) => ({
    family: font.family,
    source: font.source,
    weight: font.weight,
    style: font.style,
  }));
  return {
    runtimeOptions: {
      ...captionOptions,
      typography: { ...publicStyle, enabled: true, fontFaces },
    },
    report: {
      enabled: true,
      deterministic: prepared.length > 0,
      locale: typography.locale,
      direction: typography.direction,
      family: typography.family,
      fit: typography.fit,
      minFontSize: typography.minFontSize,
      maxFontSize: typography.maxFontSize,
      maxLines: typography.maxLines,
      minLineBalance: typography.minLineBalance,
      fontFamilies: prepared.map((font) => font.family),
      fontFiles: prepared.map((font) => (
        path.relative(fs.realpathSync(cwd), font.resolved).split(path.sep).join('/')
      )),
      fontOptimization: prepared.map((font) => ({
        family: font.family,
        sourceBytes: font.sourceBytes,
        embeddedBytes: font.embeddedBytes,
      })),
      analyzedTextCount: texts.length,
      missingGlyphs,
    },
  };
}

module.exports = {
  MAX_FONT_BYTES,
  MAX_FONTS,
  SYSTEM_FONT_STACK,
  normalizeTypographyOptions,
  prepareCaptionTypography,
  typographyStyle,
};
