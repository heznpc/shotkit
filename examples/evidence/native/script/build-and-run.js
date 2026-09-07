const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') throw new Error('native example requires macOS and the Xcode CLI tools');
const outDir = process.env.TAKE_A_REPO_OUTPUT_DIR;
if (!outDir) throw new Error('run this fixture through its take-a-repo config');
// Each producer gets a fresh bundle; no global pkill or shared build deletion.
const bundle = path.join(outDir, 'NativeProof.app');
const contents = path.join(bundle, 'Contents');
const binary = path.join(contents, 'MacOS', 'NativeProof');
fs.mkdirSync(path.dirname(binary), { recursive: true });
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
execFileSync('xcrun', ['swiftc', '-target', `${architecture}-apple-macosx14.0`, path.join(__dirname, '..', 'Proof.swift'), '-o', binary, '-framework', 'AppKit'], { stdio: 'inherit', timeout: 120000 });
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>NativeProof</string><key>CFBundleIdentifier</key><string>dev.starter-series.take-a-repo.proof</string>
<key>CFBundleName</key><string>NativeProof</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`);
execFileSync('/usr/bin/open', ['-n', '-W', bundle, '--args', outDir], { stdio: 'inherit', timeout: 20000 });
if (!fs.existsSync(path.join(outDir, 'evidence.json'))) throw new Error('native app did not produce evidence');
