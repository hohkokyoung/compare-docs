// electron-builder strips any folder named node_modules from extraResources, so
// the standalone server (which needs its own node_modules) can't be shipped that
// way. This hook copies the whole standalone tree into the packaged app's
// resources after packing, untouched.
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const productName = packager.appInfo.productFilename;

  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');

  const from = path.join(process.cwd(), '.next-build', 'standalone');
  const to = path.join(resources, 'standalone');
  if (!existsSync(from)) throw new Error(`Standalone build missing at ${from} — run the Next build first.`);

  cpSync(from, to, { recursive: true, dereference: true });
  console.log(`  • afterPack: copied standalone server -> ${to}`);
};
