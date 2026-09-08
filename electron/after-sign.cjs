const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const APP_IDENTIFIER = 'com.aios.xhscontentmonitor';

module.exports = async function stabilizeMacRequirement(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  execFileSync(
    'codesign',
    [
      '--force',
      '--sign',
      '-',
      '-r=designated => identifier "' + APP_IDENTIFIER + '"',
      join(context.appOutDir, context.packager.appInfo.productFilename + '.app'),
    ],
    { stdio: 'inherit' },
  );
};
