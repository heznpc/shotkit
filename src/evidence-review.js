const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { evidenceState } = require('./evidence-state');
const { escapeHtml } = require('./evidence-render');
const { writeJson, safeAssetPath } = require('./handoff-files');
const { validateRequestHost, validateWriteRequest, requestBody, HttpError, json, serveFile } = require('./calibrator-http');

const script = `document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{
  const feedback=Array.from(document.querySelectorAll('textarea')).filter(t=>t.value.trim()).map(t=>({deliverable:t.dataset.id,note:t.value.trim()}));
  const response=await fetch('/api/review',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':document.querySelector('meta[name=token]').content},body:JSON.stringify({status:button.dataset.status,reviewDigest:document.querySelector('meta[name=digest]').content,feedback})});
  const result=await response.json();document.querySelector('#result').textContent=result.error||result.status;
});`;

function reviewHtml(state, token) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="token" content="${token}"><meta name="digest" content="${state.reviewDigest || ''}"><title>Review product evidence</title>
<link rel="stylesheet" href="/review.css"><script defer src="/review.js"></script><h1>Review product evidence</h1>
<p>Candidate ${escapeHtml(state.id)} · ${escapeHtml(state.status)}</p><p>Approval covers every listed deliverable and its evidence files. Nothing is uploaded by this tool.</p>
${(state.report?.deliverables || []).map((d) => `<section><h2>${escapeHtml(d.id)}</h2>${d.files.map((file) => `<p><a target="_blank" rel="noopener" href="/files/${file.split(path.sep).map(encodeURIComponent).join('/')}">Open ${escapeHtml(file)}</a></p>`).join('')}<label>Requested change for ${escapeHtml(d.id)}<textarea data-id="${escapeHtml(d.id)}" maxlength="2000"></textarea></label></section>`).join('')}
<button data-status="approved" ${state.status === 'needs-fix' || !state.reviewDigest ? 'disabled' : ''}>Approve entire candidate</button>
<button data-status="changes-requested" ${!state.reviewDigest ? 'disabled' : ''}>Request changes</button><p id="result" role="status"></p>
<p>Check privacy and claim wording as well as media. Technical QA is not publication authorization.</p></html>`;
}

async function startEvidenceReview({ outDir, port = 0 }) {
  outDir = path.resolve(outDir);
  evidenceState(outDir); // Fail before opening a server when no candidate exists.
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    try {
      validateRequestHost(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/review') {
        validateWriteRequest(req);
        if (req.headers['x-review-token'] !== token) throw new HttpError(403, 'review token required');
        const body = await requestBody(req);
        const state = evidenceState(outDir); // Rehash at the write boundary.
        if (!state.reviewDigest || body.reviewDigest !== state.reviewDigest || state.problems?.length) throw new HttpError(409, 'candidate changed; reload and review again');
        if (!['approved', 'changes-requested'].includes(body.status)) throw new HttpError(400, 'invalid decision');
        if (body.status === 'approved' && state.machineStatus !== 'publish-ready') throw new HttpError(409, 'technical QA is not ready');
        if (!Array.isArray(body.feedback) || body.feedback.length > 100) throw new HttpError(400, 'invalid feedback');
        const feedback = body.feedback.map((item) => {
          const delivery = state.report.deliverables.find((d) => d.id === item.deliverable);
          if (!delivery || typeof item.note !== 'string' || !item.note.trim() || item.note.length > 2000) throw new HttpError(400, 'feedback requires a deliverable and a bounded note');
          return { deliverable: delivery.id, files: delivery.files, claims: delivery.claims, ...(delivery.source ? { source: delivery.source } : {}), note: item.note.trim() };
        });
        if (body.status === 'changes-requested' && !feedback.length) throw new HttpError(400, 'describe the requested change');
        writeJson(path.join(state.runDir, 'review.json'), { status: body.status, reviewDigest: state.reviewDigest, decidedAt: new Date().toISOString(), feedback });
        return json(res, 200, { status: body.status });
      }
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      const state = evidenceState(outDir);
      if (url.pathname === '/api/state') return json(res, 200, state);
      const textResponse = (type, body) => {
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(body);
      };
      if (url.pathname === '/') return textResponse('text/html; charset=utf-8', reviewHtml(state, token));
      if (url.pathname === '/review.js') return textResponse('text/javascript', script);
      if (url.pathname === '/review.css') return textResponse('text/css', 'body{font:17px system-ui;max-width:900px;margin:48px auto;padding:0 24px;color:#162332}section{border:1px solid #ccc;border-radius:12px;padding:24px;margin:20px 0}textarea{display:block;width:95%;min-height:70px}button{padding:14px;margin:8px 8px 8px 0}');
      if (url.pathname.startsWith('/files/')) {
        const relative = decodeURIComponent(url.pathname.slice(7));
        const asset = state.report?.files.find((a) => a.path === relative);
        if (!asset || state.problems.some((p) => p.path === relative)) throw new HttpError(409, 'file not in current verified candidate');
        const file = safeAssetPath(state.runDir, { outPath: asset.path });
        // Text is served as text, never as executable HTML supplied by a producer.
        if (!['image/png', 'video/mp4', 'video/webm', 'video/quicktime'].includes(asset.mediaType)) {
          res.writeHead(200, { 'Content-Type': asset.mediaType === 'text/html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; sandbox" });
          return fs.createReadStream(file).pipe(res);
        }
        return serveFile(req, res, file);
      }
      throw new HttpError(404, 'not found');
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { startEvidenceReview };
