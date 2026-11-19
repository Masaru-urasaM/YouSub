import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const includeList = ['manifest.json', 'src', 'assets', '_locales'];

const excludeList = [
  '.DS_Store',
  'node_modules',
  'tests',
  'scripts',
  '.git',
  '.gemini',
  '.claude',
  '.env',
  'coverage',
  'dist',
  'jest.config.cjs',
];

const assetExcludePatterns = [/\.zip$/i, /-original\./i, /\.docx$/i, /\.doc$/i, /^logo_618\.png$/i];

// ---------------------------------------------------------------------------
// Pre-build validation
// ---------------------------------------------------------------------------

function validate(manifest, pkg, constantsContent) {
  const errors = [];

  // 1. Version sync: manifest.json = package.json = Constants.VERSION
  const mVer = manifest.version;
  const pVer = pkg.version;
  const cMatch = constantsContent.match(/VERSION:\s*['"]([^'"]+)['"]/);
  const cVer = cMatch ? cMatch[1] : null;

  if (mVer !== pVer) errors.push(`Version mismatch: manifest.json=${mVer}, package.json=${pVer}`);
  if (cVer && mVer !== cVer)
    errors.push(`Version mismatch: manifest.json=${mVer}, constants.js=${cVer}`);

  // 2. IS_PRODUCTION must be false in source
  if (!constantsContent.includes('IS_PRODUCTION: false')) {
    errors.push(
      'constants.js does not contain "IS_PRODUCTION: false" — build replacement will silently fail'
    );
  }

  // 3. Verify referenced files exist
  const filesToCheck = [];

  if (manifest.background) {
    if (manifest.background.service_worker) filesToCheck.push(manifest.background.service_worker);
    if (manifest.background.scripts)
      manifest.background.scripts.forEach((s) => filesToCheck.push(s));
  }

  if (manifest.content_scripts) {
    manifest.content_scripts.forEach((cs) => {
      (cs.js || []).forEach((f) => filesToCheck.push(f));
      (cs.css || []).forEach((f) => filesToCheck.push(f));
    });
  }

  if (manifest.action && manifest.action.default_popup)
    filesToCheck.push(manifest.action.default_popup);
  if (manifest.options_page) filesToCheck.push(manifest.options_page);
  if (manifest.options_ui && manifest.options_ui.page) filesToCheck.push(manifest.options_ui.page);

  const iconSets = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
  iconSets.forEach((icons) => Object.values(icons).forEach((f) => filesToCheck.push(f)));

  if (manifest.web_accessible_resources) {
    manifest.web_accessible_resources.forEach((war) => {
      (war.resources || []).forEach((f) => filesToCheck.push(f));
    });
  }

  const missing = [...new Set(filesToCheck)].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    errors.push(`Missing files referenced in manifest.json:\n    ${missing.join('\n    ')}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Build metadata
// ---------------------------------------------------------------------------

function getBuildMetadata() {
  const buildDate = new Date().toISOString();
  let buildHash = 'unknown';
  try {
    buildHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {}
  return { buildDate, buildHash };
}

// ---------------------------------------------------------------------------
// Clean stale dist/ ZIPs
// ---------------------------------------------------------------------------

function cleanDist(distDir, name) {
  if (!fs.existsSync(distDir)) return;
  const pattern = new RegExp(`^${name}-v.*\\.zip$`, 'i');
  fs.readdirSync(distDir).forEach((file) => {
    if (pattern.test(file)) {
      fs.unlinkSync(path.join(distDir, file));
      console.log(`  [clean] Removed stale: ${file}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Recursive file addition with transforms
// ---------------------------------------------------------------------------

function shouldExcludeAsset(filePath) {
  const basename = path.basename(filePath);
  return assetExcludePatterns.some((p) => p.test(basename));
}

function addRecursive(zip, srcPath, manifestTransform, constantsTransform) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.readdirSync(srcPath).forEach((file) => {
      if (!excludeList.includes(file)) {
        addRecursive(zip, path.join(srcPath, file), manifestTransform, constantsTransform);
      }
    });
    return;
  }

  const zipPath = path.relative(process.cwd(), srcPath).replace(/\\/g, '/');

  if (shouldExcludeAsset(srcPath)) {
    console.log(`  [skip] ${zipPath}`);
    return;
  }

  if (zipPath === 'manifest.json') {
    const content = manifestTransform(fs.readFileSync(srcPath, 'utf8'));
    zip.addFile(zipPath, Buffer.from(content));
  } else if (zipPath === 'src/shared/constants.js') {
    const content = constantsTransform(fs.readFileSync(srcPath, 'utf8'));
    zip.addFile(zipPath, Buffer.from(content));
  } else {
    zip.addLocalFile(srcPath, path.dirname(zipPath));
  }
}

// ---------------------------------------------------------------------------
// Post-build verification
// ---------------------------------------------------------------------------

function verifyZip(outputPath, platform) {
  const errors = [];
  const zip = new AdmZip(outputPath);
  const entries = zip.getEntries();

  if (entries.length === 0) {
    errors.push('ZIP is empty');
    return errors;
  }

  // Check manifest.json exists and is valid
  const manifestEntry = entries.find((e) => e.entryName === 'manifest.json');
  if (!manifestEntry) {
    errors.push('manifest.json not found in ZIP');
  } else {
    try {
      const m = JSON.parse(manifestEntry.getData().toString('utf8'));
      if (platform === 'chrome' && m.browser_specific_settings) {
        errors.push('Chrome ZIP still contains browser_specific_settings');
      }
      if (platform === 'chrome' && m.background && m.background.scripts) {
        errors.push('Chrome ZIP still contains background.scripts');
      }
      if (platform === 'firefox' && m.background && m.background.service_worker) {
        errors.push('Firefox ZIP still contains background.service_worker');
      }
      if (platform === 'firefox' && !(m.background && m.background.scripts)) {
        errors.push('Firefox ZIP missing background.scripts (Firefox MV3 requires it)');
      }
      if (
        platform === 'firefox' &&
        !(m.browser_specific_settings && m.browser_specific_settings.gecko_android)
      ) {
        errors.push('Firefox ZIP missing browser_specific_settings.gecko_android');
      }
      if (platform === 'firefox' && m.options_page) {
        errors.push('Firefox ZIP still contains options_page (should use options_ui)');
      }
      if (platform === 'firefox' && !(m.options_ui && m.options_ui.page)) {
        errors.push('Firefox ZIP missing options_ui.page');
      }
    } catch (e) {
      errors.push(`manifest.json is invalid JSON: ${e.message}`);
    }
  }

  // Check IS_PRODUCTION is true
  const constEntry = entries.find((e) => e.entryName === 'src/shared/constants.js');
  if (!constEntry) {
    errors.push('src/shared/constants.js not found in ZIP');
  } else {
    const content = constEntry.getData().toString('utf8');
    if (!content.includes('IS_PRODUCTION: true')) {
      errors.push('IS_PRODUCTION is NOT set to true in ZIP');
    }
    if (content.includes('BUILD_DATE: null')) {
      errors.push('BUILD_DATE was not injected');
    }
  }

  // Check no excluded assets leaked in
  entries.forEach((e) => {
    if (shouldExcludeAsset(e.entryName)) {
      errors.push(`Excluded asset leaked into ZIP: ${e.entryName}`);
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Build for a single platform
// ---------------------------------------------------------------------------

function buildForPlatform(platform, manifest, constantsTransform) {
  const zip = new AdmZip();
  const name = manifest.name.toLowerCase().replace(/\s+/g, '-');
  const version = manifest.version;

  const manifestTransform = (raw) => {
    const m = JSON.parse(raw);
    if (platform === 'chrome') {
      delete m.browser_specific_settings;
      delete m.background.scripts;
    }
    if (platform === 'firefox') {
      // Firefox MV3 uses background.scripts (non-persistent event page);
      // service_worker is Chrome-only. Source manifest ships service_worker
      // (Chrome-clean, no dev-load warning), so derive scripts here.
      m.background.scripts = [m.background.service_worker];
      delete m.background.service_worker;

      // Firefox MV3 prefers options_ui with open_in_tab over Chrome's options_page.
      if (m.options_page) {
        m.options_ui = { page: m.options_page, open_in_tab: true };
        delete m.options_page;
      }
    }
    return JSON.stringify(m, null, 2) + '\n';
  };

  console.log(`\n[${'='.repeat(50)}]`);
  console.log(`  Building ${name} v${version} [${platform}]`);
  console.log(`[${'='.repeat(50)}]`);

  includeList.forEach((item) => {
    if (fs.existsSync(item)) {
      addRecursive(zip, item, manifestTransform, constantsTransform);
    }
  });

  const outputPath = path.join('dist', `${name}-v${version}-${platform}.zip`);
  zip.writeZip(outputPath);

  const stats = fs.statSync(outputPath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  const fileCount = zip.getEntries().length;
  console.log(`  Created: ${outputPath} (${fileCount} files, ${sizeMB} MB)`);

  // Post-build verification
  const verifyErrors = verifyZip(outputPath, platform);
  if (verifyErrors.length > 0) {
    console.error(`\n  [VERIFY FAILED] ${platform}:`);
    verifyErrors.forEach((e) => console.error(`    - ${e}`));
    process.exit(1);
  }
  console.log(`  [VERIFY OK] All checks passed for ${platform}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const platforms = process.argv[2] === 'all' ? ['chrome', 'firefox'] : [process.argv[2] || 'all'];

if (platforms[0] === 'all') {
  platforms.length = 0;
  platforms.push('chrome', 'firefox');
}

// Read source files
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const constantsContent = fs.readFileSync('src/shared/constants.js', 'utf8');

console.log(`\nYouSub Build Pipeline v2.0`);
console.log(`${'─'.repeat(40)}`);

// Pre-build validation
console.log('\n[PRE-BUILD VALIDATION]');
const validationErrors = validate(manifest, pkg, constantsContent);
if (validationErrors.length > 0) {
  console.error('\nBuild FAILED — validation errors:');
  validationErrors.forEach((e) => console.error(`  ✗ ${e}`));
  process.exit(1);
}
console.log('  All checks passed.');

// Build metadata
const { buildDate, buildHash } = getBuildMetadata();
console.log(`  Build date: ${buildDate}`);
console.log(`  Git hash:   ${buildHash}`);

// Constants transform
const constantsTransform = (content) => {
  console.log('  --> constants.js: IS_PRODUCTION=true, BUILD_DATE, BUILD_HASH injected');
  return content
    .replace('IS_PRODUCTION: false', 'IS_PRODUCTION: true')
    .replace('BUILD_DATE: null', `BUILD_DATE: '${buildDate}'`)
    .replace('BUILD_HASH: null', `BUILD_HASH: '${buildHash}'`);
};

// Clean stale artifacts
const name = manifest.name.toLowerCase().replace(/\s+/g, '-');
if (!fs.existsSync('dist')) fs.mkdirSync('dist');
cleanDist('dist', name);

// Build
platforms.forEach((p) => buildForPlatform(p, manifest, constantsTransform));

console.log(`\nBuild complete.`);
