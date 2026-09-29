const { build } = require('./package.json');
const mediaTools = require('./scripts/media-tools.cjs');
const buildSpace = require('./scripts/build-space-guard.cjs');
const path = require('node:path');

// extraMetadata changes only the packaged package.json, not development defaults.
module.exports = {
  ...build,
  extraResources: [
    ...(build.extraResources || []),
    {
      from: path.join(process.env.OZON_MEDIA_TOOLS_DIR || 'build/media-tools', '${os}-${arch}'), to: 'media-tools',
      filter: ['ffmpeg', 'ffprobe', 'ffmpeg.exe', 'ffprobe.exe', 'manifest.json', 'NOTICE.txt', 'COPYING.GPLv3', 'THIRD-PARTY-NOTICES.txt', 'BUILDING.md', 'SOURCE-RELEASE.json'],
    },
    {from: path.join(__dirname, '..', 'shared', 'ozon-video-processing.mjs'), to: 'shared/ozon-video-processing.mjs'},
  ],
  mac: {
    ...build.mac,
    binaries: [...(build.mac.binaries || []), 'Contents/Resources/media-tools/ffmpeg', 'Contents/Resources/media-tools/ffprobe'],
  },
  beforePack: async (context) => {
    buildSpace.beforePack(context);
    await mediaTools.beforePack(context);
  },
  afterPack: mediaTools.afterPack,
  extraMetadata: {
    sonliRuntime: {
      apiBase: 'https://www.ozonzongzi.com/api',
      webBase: 'https://www.ozonzongzi.com',
    },
  },
};
