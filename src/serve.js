/*
 * Store-asset harness — minimal localhost fixture server.
 *
 * Why a real HTTP server and not Playwright route().fulfill(): fulfilled
 * responses do NOT trigger MV3 content-script injection in Chromium, so
 * screenshot fixtures have to come from a real http:// origin. This server
 * is deliberately tiny — it serves static files from one directory, with a
 * permissive CSP so fixtures can use inline styles/scripts, and an optional
 * fallback file so any path (e.g. a faux course-slug URL) resolves to a page
 * the content script will match.
 *
 * Projects with richer needs (path-routed fixtures, request stubbing) bring
 * their own server in take-a-repo.config.js's setup() instead.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { safeAssetPath } = require('./handoff-files');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// Permissive CSP so fixtures can carry inline <style>/<script> and the
// extension's web-accessible resources load without policy friction.
const FIXTURE_CSP =
  "default-src * data: blob: 'unsafe-eval' 'unsafe-inline'; " +
  "script-src * 'unsafe-eval' 'unsafe-inline' data: blob:; " +
  "style-src * 'unsafe-inline'";

/**
 * Serve `dir` over http on a random loopback port.
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {string} [opts.fallback] filename (relative to dir) served for any
 *   path that doesn't map to an existing file — lets a single fixture answer
 *   arbitrary URLs (handy for faking deep/slug paths).
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
function serveDirectory(dir, opts = {}) {
  const root = path.resolve(dir);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // A synchronous throw inside this handler would become an uncaughtException
      // that kills the whole capture process, so guard the entire body. Malformed
      // percent-encoding (decodeURIComponent), a TOCTOU race between existsSync and
      // read, or a permission/EACCES error must all yield an HTTP status, not a crash.
      let urlPath;
      try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
        return;
      }
      try {
        // Path-traversal sanitizer (CodeQL js/path-injection): normalize, then
        // strip any leading `../` segments so the join can't escape `root`.
        const rel = path.normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
        let filePath = path.join(root, rel);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = opts.fallback ? path.join(root, opts.fallback) : null;
        }
        filePath = filePath && safeAssetPath(root, { outPath: filePath });
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
          'Content-Security-Policy': FIXTURE_CSP,
        });
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => res.destroy());
        res.once('close', () => stream.destroy());
        stream.pipe(res);
      } catch (err) {
        // Only write a new status when none has been sent; otherwise abort.
        if (!res.headersSent) {
          res.writeHead(err && err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
          res.end('Server error');
        } else {
          res.destroy();
        }
      }
    });
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { serveDirectory, FIXTURE_CSP };
