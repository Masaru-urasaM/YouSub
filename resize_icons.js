import { Jimp } from 'jimp';
import fs from 'fs';

async function resizeIcon() {
  const source =
    'C:/Users/admin/.gemini/antigravity/brain/5c63939b-0bb6-40d9-aedc-730e909e456c/yousub_logo_sub_transparent_1775524021713.png';
  const targetDir = 'd:/Xinh/XinhTools/YouSub/assets/icons/';

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const image = await Jimp.read(source);

  console.log('Resizing to 128x128...');
  await image
    .clone()
    .resize(128, 128)
    .writeAsync(targetDir + 'icon128.png');

  console.log('Resizing to 48x48...');
  await image
    .clone()
    .resize(48, 48)
    .writeAsync(targetDir + 'icon48.png');

  console.log('Resizing to 16x16...');
  await image
    .clone()
    .resize(16, 16)
    .writeAsync(targetDir + 'icon16.png');

  console.log('Icons updated and optimized!');
}

resizeIcon().catch(console.error);
