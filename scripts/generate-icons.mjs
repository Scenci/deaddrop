import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const srcDir = './src/assets';
const tauriIconsDir = './src-tauri/icons';

// Read the base icon SVG and make background transparent
const iconSvg = fs.readFileSync(path.join(srcDir, 'icon.svg'), 'utf8');
const transparentSvg = iconSvg.replace('fill="#0a0a0a"', 'fill="none"');

// Icon sizes needed for Tauri
const sizes = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
  { name: 'Square30x30Logo.png', size: 30 },
  { name: 'Square44x44Logo.png', size: 44 },
  { name: 'Square71x71Logo.png', size: 71 },
  { name: 'Square89x89Logo.png', size: 89 },
  { name: 'Square107x107Logo.png', size: 107 },
  { name: 'Square142x142Logo.png', size: 142 },
  { name: 'Square150x150Logo.png', size: 150 },
  { name: 'Square284x284Logo.png', size: 284 },
  { name: 'Square310x310Logo.png', size: 310 },
  { name: 'StoreLogo.png', size: 50 },
];

async function generateIcons() {
  console.log('Generating PNG icons with transparent background...\n');

  for (const { name, size } of sizes) {
    const outputPath = path.join(tauriIconsDir, name);

    // Create SVG buffer with proper dimensions
    const svgWithSize = transparentSvg
      .replace(/width="512"/, `width="${size}"`)
      .replace(/height="512"/, `height="${size}"`);

    await sharp(Buffer.from(svgWithSize))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Generated: ${name} (${size}x${size})`);
  }

  console.log('\nPNG icons generated successfully!');
  console.log('\nNote: For icon.ico and icon.icns, you may need to use additional tools:');
  console.log('  - Windows: Use a tool like png2ico or an online converter');
  console.log('  - macOS: Use iconutil or an online converter');
}

generateIcons().catch(console.error);
