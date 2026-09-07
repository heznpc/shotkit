const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createServer } = require('./service');

async function main() {
  const outDir = process.env.TAKE_A_REPO_OUTPUT_DIR;
  if (!outDir) throw new Error('run through take-a-repo so the output directory is explicit');
  const mode = process.argv[2];
  const observations = [];
  if (mode === 'cli') {
    for (const input of ['100', 'invalid']) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'service.js'), input], { encoding: 'utf8' });
      observations.push({ input, exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
    }
  } else if (mode === 'api') {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const route of ['/convert?celsius=100', '/missing', '/convert?celsius=invalid']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
        observations.push({ request: { method: 'GET', path: route }, status: response.status, body: await response.json() });
      }
    } finally { await new Promise((resolve) => server.close(resolve)); }
  } else throw new Error('expected cli or api');
  const checks = mode === 'cli' ? [
    { id: 'converts', status: observations[0].exitCode === 0 && JSON.parse(observations[0].stdout).fahrenheit === 212 ? 'pass' : 'fail', summary: 'CLI converts 100 Celsius to 212 Fahrenheit' },
    { id: 'rejects-invalid', status: observations[1].exitCode !== 0 ? 'pass' : 'fail', summary: 'CLI rejects invalid numeric input' },
  ] : [
    { id: 'converts', status: observations[0].status === 200 && observations[0].body.fahrenheit === 212 ? 'pass' : 'fail', summary: 'API returns 200 with the expected conversion' },
    { id: 'rejects-invalid', status: observations[1].status === 404 && observations[2].status === 400 ? 'pass' : 'fail', summary: 'API returns 404 for unknown routes and 400 for invalid input' },
  ];
  fs.writeFileSync(path.join(outDir, 'observations.json'), JSON.stringify(observations, null, 2));
  fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify({
    version: 1,
    assets: [{ id: 'observations', path: 'observations.json', mediaType: 'application/json', role: mode === 'api' ? 'request-response' : 'transcript' }],
    checks: checks.map((check) => ({ ...check, assets: ['observations'] })),
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
