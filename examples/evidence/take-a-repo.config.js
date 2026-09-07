module.exports = {
  outDir: process.env.TAKE_A_REPO_EXAMPLE_OUT || 'product-evidence',
  evidence: {
    version: 1,
    producers: [
      { id: 'cli', kind: 'cli', command: [process.execPath, 'collect.js', 'cli'] },
      { id: 'api', kind: 'api', command: [process.execPath, 'collect.js', 'api'] },
    ],
    claims: [
      { id: 'conversion', text: 'CLI and API convert 100°C to 212°F', checks: ['cli:converts', 'api:converts'] },
      { id: 'invalid-input', text: 'Invalid input is rejected and unknown API routes return 404', checks: ['cli:rejects-invalid', 'api:rejects-invalid'] },
    ],
    deliverables: [{ id: 'release-proof', kind: 'proof', claims: ['conversion', 'invalid-input'] }],
  },
};
