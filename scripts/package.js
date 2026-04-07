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

// Files/folders to include
const includeList = [
  'manifest.json',
  'src',
  'assets',
  '_locales', // if exists
];

// Clean exclusion list
const excludeList = [
  '.DS_Store',
  'node_modules',
  'tests',
  'scripts',
  '.git',
  '.gemini',
];

const zip = new AdmZip();

function addRecursive(srcPath) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(srcPath);
    files.forEach(file => {
      if (!excludeList.includes(file)) {
        addRecursive(path.join(srcPath, file));
      }
    });
  } else {
    // Add file
    const zipPath = path.relative(process.cwd(), srcPath);
    const normalizedZipPath = zipPath.replace(/\\/g, '/');

    if (normalizedZipPath === 'src/shared/constants.js') {
      console.log('  --> Splicing constants.js: setting IS_PRODUCTION to true');
      let content = fs.readFileSync(srcPath, 'utf8');
      content = content.replace('IS_PRODUCTION: false', 'IS_PRODUCTION: true');
      zip.addFile(normalizedZipPath, Buffer.from(content));
    } else {
      zip.addLocalFile(srcPath, path.dirname(zipPath));
    }
  }
}

console.log(`Packaging ${name} v${version}...`);

includeList.forEach(item => {
  if (fs.existsSync(item)) {
    addRecursive(item);
  }
});

const outputPath = path.join(distDir, `${name}-v${version}.zip`);
zip.writeZip(outputPath);

console.log(`Successfully created ${outputPath}`);
