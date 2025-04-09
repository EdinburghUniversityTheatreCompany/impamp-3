import fs from 'fs';
import path from 'path';
import { createCanvas } from 'canvas';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Icon sizes required by PWA
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

// Ensure icons directory exists
const iconsDir = path.join(__dirname, '../public/icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate icons for each size
sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  
  // Calculate dimensions (10% of size for padding)
  
  // Draw a stylized 'IA' for ImpAmp
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size * 0.5}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ImpAmp 2', size / 2, size / 2);
  
  // Add a sound wave effect (simplified)
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = Math.max(2, size * 0.02);
  
  // Draw 3 sound wave arcs
  for (let i = 1; i <= 3; i++) {
    const radius = size * 0.2 * i;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, Math.PI * 0.8, Math.PI * 1.2);
    ctx.stroke();
  }
  
  // Save the icon to file
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(iconsDir, `icon-${size}x${size}.png`), buffer);
  
  console.log(`Generated icon with size ${size}x${size}`);
});

console.log('All icons generated successfully!');
