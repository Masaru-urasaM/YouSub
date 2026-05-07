import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const version = manifest.version;
const name = manifest.name.toLowerCase().replace(/\s+/g, '-');

const distDir = 'dist';
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir);
}

const includeList = [
  'manifest.json',
  'src',
  'assets',
  '_locales',
];

const excludeList = [
  '.DS_Store',
  'node_modules',
  'tests',
  'scripts',
  '.git',
  '.gemini',
];

const platforms = process.argv[2] === 'all'
  ? ['chrome', 'firefox']
  : [process.argv[2] || 'all'];

if (platforms[0] === 'all') {
  platforms.length = 0;
  platforms.push('chrome', 'firefox');
}

function addRecursive(zip, srcPath, manifestTransform) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(srcPath);
    files.forEach(file => {
      if (!excludeList.includes(file)) {
        addRecursive(zip, path.join(srcPath, file), manifestTransform);
      }
    });
  } else {
    const zipPath = path.relative(process.cwd(), srcPath);
    const normalizedZipPath = zipPath.replace(/\\/g, '/');

    if (normalizedZipPath === 'manifest.json') {
      const content = manifestTransform(fs.readFileSync(srcPath, 'utf8'));
      zip.addFile(normalizedZipPath, Buffer.from(content));
    } else if (normalizedZipPath === 'src/shared/constants.js') {
      console.log('  --> Splicing constants.js: setting IS_PRODUCTION to true');
      let content = fs.readFileSync(srcPath, 'utf8');
      content = content.replace('IS_PRODUCTION: false', 'IS_PRODUCTION: true');
      zip.addFile(normalizedZipPath, Buffer.from(content));
    } else {
      zip.addLocalFile(srcPath, path.dirname(zipPath));
    }
  }
}

function buildForPlatform(platform) {
  const zip = new AdmZip();

  const manifestTransform = (raw) => {
    const m = JSON.parse(raw);
    if (platform === 'chrome') {
      delete m.browser_specific_settings;
      delete m.background.scripts;
    }
    if (platform === 'firefox') {
      delete m.background.service_worker;
    }
    return JSON.stringify(m, null, 2) + '\n';
  };

  console.log(`\nPackaging ${name} v${version} [${platform}]...`);

  includeList.forEach(item => {
    if (fs.existsSync(item)) {
      addRecursive(zip, item, manifestTransform);
    }
  });

  const outputPath = path.join(distDir, `${name}-v${version}-${platform}.zip`);
  zip.writeZip(outputPath);
  console.log(`  Created ${outputPath}`);
}

platforms.forEach(buildForPlatform);
console.log('\nDone!');
