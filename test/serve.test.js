const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { serveDirectory } = require('../src/serve');

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      })
      .on('error', reject);
  });
}

describe('serveDirectory', () => {
  let dir;
  let server;
  let baseUrl;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-serve-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>idx</h1>');
    fs.writeFileSync(path.join(dir, 'demo.html'), '<h1>demo</h1>');
    server = await serveDirectory(dir, { fallback: 'demo.html' });
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
  });

  test('serves index.html at /', async () => {
    const r = await get(`${baseUrl}/`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('idx');
  });

  test('serves the fallback for an unknown path', async () => {
    const r = await get(`${baseUrl}/course/anything`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('demo');
  });

  test('does NOT leak files outside the root (path traversal)', async () => {
    // URL-encoded so the client cannot collapse the `..` before it reaches us.
    const r = await get(`${baseUrl}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/hosts`);
    // Must never serve /etc/hosts (which contains "localhost"); the sanitizer
    // confines to root, so this resolves to the in-root fallback instead.
    expect(r.body).not.toMatch(/localhost/i);
    expect(r.body).toContain('demo');
  });

  test('does not follow a fixture symlink outside the served directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-serve-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'private.txt'), 'outside-fixture');
      fs.symlinkSync(outside, path.join(dir, 'external'));
      const response = await get(`${baseUrl}/external/private.txt`);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain('outside-fixture');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
