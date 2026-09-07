// A non-web consumer: deterministic CLI + JSON API. No browser dependencies.
const http = require('http');

function convert(celsius) {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) throw new Error('celsius must be a finite number');
  return { celsius, fahrenheit: celsius * 9 / 5 + 32 };
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname !== '/convert') {
      res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      if (!url.searchParams.has('celsius')) throw new Error('celsius is required');
      res.end(JSON.stringify(convert(Number(url.searchParams.get('celsius')))));
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: error.message })); }
  });
}

if (require.main === module) {
  try {
    if (process.argv[2] == null) throw new Error('usage: node service.js <celsius>');
    console.log(JSON.stringify(convert(Number(process.argv[2]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createServer, convert };
