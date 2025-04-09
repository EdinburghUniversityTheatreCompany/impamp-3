import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const svgPath = path.join(__dirname, '../public/icons/icon.svg');
const faviconPath = path.join(__dirname, '../src/app/favicon.ico');

// Size to generate
const faviconSize = 256;

async function generateFavicon() {
  try {
    console.log('Reading SVG source...');
    const svgBuffer = fs.readFileSync(svgPath);
    
    // Generate single 256x256 favicon
    console.log(`Generating ${faviconSize}x${faviconSize} favicon...`);
    const faviconBuffer = await sharp(svgBuffer)
      .resize(faviconSize, faviconSize)
      .png()
      .toBuffer();
    
    // Save as favicon.ico
    fs.writeFileSync(faviconPath, faviconBuffer);

    console.log('✓ Favicon generated successfully!');
  } catch (error) {
    console.error('Error generating favicon:', error);
    process.exit(1);
  }
}

generateFavicon();
