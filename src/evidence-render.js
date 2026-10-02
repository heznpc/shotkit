const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findFfmpeg, ffmpegTimeoutMs } = require('./video');
const { videoComposition, verifyVideoComposition } = require('./video-composition');
const { measureAsset } = require('./evidence-contract');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function proofHtml(report, selectedClaims) {
  const claims = report.claims.filter((c) => selectedClaims.includes(c.id));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Product evidence</title><style>body{font:17px system-ui;max-width:960px;margin:48px auto;padding:0 24px;color:#162332;background:#f8fafc;overflow-wrap:anywhere}article{background:white;padding:24px;margin:20px 0;border:1px solid #dbe3ea;border-radius:12px}img,video{max-width:100%;max-height:600px}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#536171}</style>
<h1>Product evidence</h1><p>Local review candidate — publication requires explicit user approval.</p>
<small>Run ${escapeHtml(report.id)} · Revision ${escapeHtml(report.source.revision || 'unknown')} · ${report.source.dirty ? 'working tree has changes' : 'clean tree'}</small>
${claims.map((c) => `<article><h2>${escapeHtml(c.text)}</h2><strong>${escapeHtml(c.status)}</strong><ul>${c.checks.map((ref) => `<li>${escapeHtml(ref)}</li>`).join('')}</ul></article>`).join('')}
${report.producers.map((p) => `<article><h2>${escapeHtml(p.id)} · ${escapeHtml(p.kind)}</h2><p>${escapeHtml(p.mode)} / ${escapeHtml(p.status)}</p>
${p.mode === 'reused' ? `<p>Reused capture from ${escapeHtml(p.origin?.finishedAt)} · original run ${escapeHtml(p.origin?.runId)}. These checks were not executed again for this candidate.</p>` : ''}
${p.checks.map((c) => `<p>${escapeHtml(c.id)}: ${escapeHtml(c.status)} — ${escapeHtml(c.summary)} <small>(${escapeHtml(c.verification)})</small></p>`).join('')}
${p.assets.map((a) => { const url = '../' + a.path.split(path.sep).map(encodeURIComponent).join('/'); return `<h3>${escapeHtml(a.description || a.id)}</h3>${a.mediaType === 'image/png' ? `<img src="${url}" alt="${escapeHtml(a.id)}">` : a.mediaType.startsWith('video/') ? `<video controls src="${url}"></video>` : `<p><a href="${url}">${escapeHtml(a.role)}: ${escapeHtml(a.id)}</a></p>`}<small>SHA-256 ${a.sha256}</small>`; }).join('')}
${p.error ? `<pre>${escapeHtml(p.error)}</pre>` : ''}</article>`).join('')}
<p>Review the actual linked files. Producer assertions are not independent certification; imported checks are unverified.</p></html>`;
}

function renderDeliverable(spec, report, runDir) {
  const dir = path.join(runDir, 'deliverables');
  fs.mkdirSync(dir, { recursive: true });
  if (spec.kind === 'proof') {
    const file = path.join(dir, `${spec.id}.html`);
    fs.writeFileSync(file, proofHtml(report, spec.claims));
    return [{ id: spec.id, path: path.relative(runDir, file), mediaType: 'text/html', role: 'proof-page' }];
  }
  const [producerId, assetId] = spec.source.split(':');
  const producer = report.producers.find((p) => p.id === producerId);
  const input = producer?.assets.find((a) => a.id === assetId);
  if (!input || !input.mediaType.startsWith('video/')) throw new Error(`video source missing: ${spec.source}`);
  const composition = videoComposition(spec, input);
  const { profile, duration, sourceFilter, fps, thumbnailAt } = composition;
  const bin = findFfmpeg();
  if (!bin) throw new Error('channel rendering needs ffmpeg');
  const video = path.join(dir, `${spec.id}.mp4`);
  const poster = path.join(dir, `${spec.id}.png`);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path.join(runDir, input.path)];
  args.push('-vf', sourceFilter, '-an', '-t', String(duration), '-r', String(fps), '-c:v', 'libx264', '-crf', String(profile.mp4.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video);
  const options = { stdio: ['ignore', 'ignore', 'pipe'], timeout: ffmpegTimeoutMs(), killSignal: 'SIGKILL' };
  execFileSync(bin, args, options);
  const measured = measureAsset(runDir, { id: spec.id, path: path.relative(runDir, video), mediaType: 'video/mp4', role: 'recording', captionState: input.captionState || 'unknown' });
  const qa = measured.qa;
  verifyVideoComposition(qa, composition);
  execFileSync(bin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(thumbnailAt), '-i', video, '-frames:v', '1', poster], options);
  const thumbnail = measureAsset(runDir, { id: `${spec.id}-poster`, path: path.relative(runDir, poster), mediaType: 'image/png', role: 'screenshot' });
  return [measured, thumbnail];
}

module.exports = { renderDeliverable, escapeHtml };
