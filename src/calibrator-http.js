const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname, '..', 'calibrator');
const CAMPAIGN_STATIC_DIR = path.join(__dirname, '..', 'campaign');
const MAX_BODY_BYTES = 256 * 1024;
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function securityHeaders() {
  return {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

function json(res, status, payload) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    default: return 'application/octet-stream';
  }
}

function safeStaticPathIn(staticDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_error) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = urlPath === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = path.resolve(staticDir, normalized);
  return resolved.startsWith(`${path.resolve(staticDir)}${path.sep}`) ? resolved : null;
}

function safeStaticPath(urlPath) {
  return safeStaticPathIn(STATIC_DIR, urlPath);
}

function safeCampaignStaticPath(urlPath) {
  const relative = urlPath === '/campaign/'
    ? '/'
    : urlPath.slice('/campaign'.length) || '/';
  return safeStaticPathIn(CAMPAIGN_STATIC_DIR, relative);
}

function pipeFile(res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);
  // A candidate can disappear after stat/rehash. Stream errors are asynchronous
  // and cannot be caught by the request handler's surrounding try/catch.
  stream.on('error', () => res.destroy());
  res.once('close', () => stream.destroy());
  stream.pipe(res);
}

function serveFile(req, res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, securityHeaders()).end('Not found');
    return;
  }
  const size = fs.statSync(filePath).size;
  const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isInteger(start) || start < 0 || start > end || start >= size) {
      res.writeHead(416, { ...securityHeaders(), 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...securityHeaders(),
      'Content-Type': contentType(filePath),
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    pipeFile(res, filePath, { start, end });
    return;
  }
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': contentType(filePath),
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  pipeFile(res, filePath);
}

async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_error) {
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

function isLoopbackHost(value) {
  return typeof value === 'string' && /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(value);
}

function validateRequestHost(req) {
  if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'request host must be local');
}

function validateWriteRequest(req) {
  const header = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (header !== 'application/json') {
    throw new HttpError(415, 'write requests require application/json');
  }
  if (!req.headers.origin) return;
  let origin;
  try {
    origin = new URL(req.headers.origin);
  } catch (_error) {
    throw new HttpError(403, 'request origin must match the local dashboard');
  }
  if (origin.protocol !== 'http:' || origin.host.toLowerCase() !== String(req.headers.host).toLowerCase()) {
    throw new HttpError(403, 'request origin must match the local dashboard');
  }
}

function safeMediaPath(outDir, name) {
  const candidate = path.join(outDir, name);
  try {
    const root = fs.realpathSync(outDir);
    const resolved = fs.realpathSync(candidate);
    return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  HttpError,
  json,
  requestBody,
  safeCampaignStaticPath,
  safeMediaPath,
  safeStaticPath,
  securityHeaders,
  serveFile,
  pipeFile,
  validateRequestHost,
  validateWriteRequest,
};
