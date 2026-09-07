module.exports = {
  outDir: process.env.TAKE_A_REPO_EXAMPLE_OUT || 'product-evidence',
  evidence: {
    version: 1,
    producers: [{ id: 'native', kind: 'native', command: [process.execPath, 'script/build-and-run.js'], timeoutMs: 180000 }],
    claims: [{ id: 'conversion', text: 'The native AppKit action converts Celsius and rejects invalid input', checks: ['native:converts'] }],
    deliverables: [{ id: 'native-proof', kind: 'proof', claims: ['conversion'] }],
  },
};
