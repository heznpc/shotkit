const fs = require('fs');
const path = require('path');

const { loadApproval, syncManifestApproval } = require('./approval');
const {
  applyCalibrationProfiles,
  calibrationProfileHash,
  loadCalibration,
} = require('./calibration');
const { hasCalibration } = require('./calibration-verification');
const { normalizeDemoConfigs } = require('./demo');
const { writeJson } = require('./handoff-files');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function safeArea(target, viewport) {
  if (target === 'youtube-shorts') {
    return {
      x: 40,
      y: 96,
      width: Math.max(0, viewport.width - 160),
      height: Math.max(0, viewport.height - 416),
    };
  }
  return {
    x: 48,
    y: 40,
    width: Math.max(0, viewport.width - 96),
    height: Math.max(0, viewport.height - 88),
  };
}

function assetFor(assets, demoName, role) {
  return assets.find((asset) => asset.role === role && asset.source && asset.source.name === demoName);
}

function profileFor(document, story, target) {
  return document.profiles && document.profiles[story] && document.profiles[story][target]
    ? document.profiles[story][target]
    : {};
}

function hasProfile(document, story, target) {
  return !!(document.profiles && document.profiles[story]
    && Object.prototype.hasOwnProperty.call(document.profiles[story], target));
}

function applyCalibrationHashes(manifest, calibrationDocument) {
  const targets = manifest.handoff && manifest.handoff.automation
    ? manifest.handoff.automation.targets || []
    : [];
  for (const target of targets) {
    const profile = profileFor(calibrationDocument, target.story, target.target);
    if (!target.profileHash && profile.verification) {
      const profileHash = calibrationProfileHash(profile);
      if (profile.verification.status === 'publish-ready'
        && profile.verification.profileHash === profileHash) {
        target.profileHash = profileHash;
      }
    }
  }
}

function calibrationApprovalOptions(calibrationDocument) {
  return {
    targetContext(target) {
      const profile = profileFor(calibrationDocument, target.story, target.target);
      const saved = hasProfile(calibrationDocument, target.story, target.target);
      const profileHash = saved ? calibrationProfileHash(profile) : null;
      const verified = !!(saved && profile.verification
        && profile.verification.status === 'publish-ready'
        && profile.verification.profileHash === profileHash
        && (!target.profileHash || target.profileHash === profileHash));
      return { ready: verified, profileHash };
    },
  };
}

function syncApprovalManifest(outDir, approvalDocument, calibrationDocument) {
  const manifestPath = path.join(outDir, 'take-a-repo-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest || !manifest.handoff || !manifest.handoff.automation) return null;
  if (calibrationDocument) applyCalibrationHashes(manifest, calibrationDocument);
  const gate = syncManifestApproval(
    manifest,
    approvalDocument,
    { outDir, ...(calibrationDocument ? calibrationApprovalOptions(calibrationDocument) : {}) },
  );
  writeJson(manifestPath, manifest);
  return gate;
}

function createStateReader({ cwd, config }) {
  const outDir = path.resolve(cwd, config.outDir || 'store-assets');
  const calibrationEnabled = hasCalibration(config);
  return function state(selected = {}) {
    const calibration = loadCalibration(config, cwd);
    const approval = loadApproval(outDir);
    const demos = applyCalibrationProfiles(normalizeDemoConfigs(config), calibration.document)
      .filter((demo) => demo.target);
    const manifest = readJson(path.join(outDir, 'take-a-repo-manifest.json'), {});
    if (calibrationEnabled) applyCalibrationHashes(manifest, calibration.document);
    const storyboard = readJson(path.join(outDir, 'storyboard.json'), {});
    const captions = readJson(path.join(outDir, 'captions.json'), {});
    const assets = manifest.assets || [];
    const automationTargets = manifest.handoff && manifest.handoff.automation
      ? manifest.handoff.automation.targets || []
      : [];
    const approvalGate = syncManifestApproval(
      manifest,
      approval.document,
      { outDir, ...(calibrationEnabled ? calibrationApprovalOptions(calibration.document) : {}) },
    );
    const approvalByKey = new Map((approvalGate.targets || []).map((item) => (
      [`${item.story}::${item.target}`, item]
    )));
    const storyboardByName = new Map((storyboard.demos || []).map((demo) => [demo.name, demo]));
    const captionByName = new Map((captions.demos || []).map((demo) => [demo.name, demo]));
    const lintByName = new Map((storyboard.storyboardLint || []).map((item) => (
      [item.name, item.warnings || []]
    )));
    const layouts = config.calibration && Array.isArray(config.calibration.layouts)
      ? config.calibration.layouts
      : ['default'];
    const targets = demos.map((demo) => {
      const story = demo.story || demo.name;
      const board = storyboardByName.get(demo.name) || {};
      const caption = captionByName.get(demo.name) || {};
      const viewport = board.viewport
        || (demo.targetProfile && demo.targetProfile.viewport)
        || { width: 1280, height: 720 };
      const mp4 = assetFor(assets, demo.name, 'sns-demo-mp4');
      const thumbnail = assetFor(assets, demo.name, 'thumbnail');
      const directVideo = path.join(outDir, `${demo.name}.mp4`);
      const directThumbnail = path.join(outDir, `${demo.name}-thumbnail.png`);
      const publish = automationTargets.find((item) => (
        item.demo === demo.name && item.target === demo.target
      ));
      const approvalTarget = approvalByKey.get(`${story}::${demo.target}`) || {
        status: 'not-ready',
        assetDigest: null,
        stale: false,
      };
      const profile = profileFor(calibration.document, story, demo.target);
      const savedProfile = hasProfile(calibration.document, story, demo.target);
      const profileHash = calibrationEnabled
        ? savedProfile ? calibrationProfileHash(profile) : null
        : approvalTarget.profileHash || (publish && publish.profileHash) || null;
      const verified = !calibrationEnabled || !!(savedProfile && profile.verification
        && publish && publish.status === 'publish-ready'
        && profile.verification.status === 'publish-ready'
        && profile.verification.profileHash === profileHash);
      const publishStatus = publish ? publish.status : 'not-requested';
      const reviewable = publishStatus === 'publish-ready' && verified
        && approvalTarget.status !== 'not-ready' && !!approvalTarget.assetDigest;
      const reviewStatus = reviewable ? approvalTarget.status : 'not-ready';
      const status = publishStatus === 'publish-ready'
        ? reviewable ? reviewStatus : 'needs-fix'
        : publishStatus;
      const videoName = mp4 && mp4.outPath ? path.basename(mp4.outPath) : path.basename(directVideo);
      const thumbnailName = thumbnail && thumbnail.outPath
        ? path.basename(thumbnail.outPath)
        : path.basename(directThumbnail);
      return {
        story,
        target: demo.target,
        name: demo.name,
        status,
        machineStatus: publishStatus,
        viewport,
        safeArea: safeArea(demo.target, viewport),
        videoUrl: fs.existsSync(path.join(outDir, videoName))
          ? `/media/${encodeURIComponent(videoName)}` : null,
        thumbnailUrl: fs.existsSync(path.join(outDir, thumbnailName))
          ? `/media/${encodeURIComponent(thumbnailName)}` : null,
        beats: board.beats || caption.captions || [],
        captionStyle: caption.style || board.captionStyle || {},
        warnings: lintByName.get(demo.name) || [],
        layouts,
        profile,
        hasProfile: savedProfile,
        profileHash,
        verified,
        reviewable,
        publishable: reviewable && reviewStatus === 'approved',
        review: {
          status: reviewStatus,
          stale: !!approvalTarget.stale,
          ...(approvalTarget.decision ? { decision: approvalTarget.decision } : {}),
        },
        assetDigest: approvalTarget.assetDigest,
      };
    });
    const active = targets.find((item) => (
      item.story === selected.story && item.target === selected.target
    )) || targets[0] || null;
    return {
      project: path.basename(cwd),
      calibratorAvailable: calibrationEnabled,
      calibrationPath: calibration.path ? path.relative(cwd, calibration.path) : null,
      targets,
      selected: active ? { story: active.story, target: active.target } : null,
      approvalStatus: approvalGate.status,
    };
  };
}

module.exports = {
  createStateReader,
  profileFor,
  syncApprovalManifest,
};
