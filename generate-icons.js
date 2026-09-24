import fs from 'fs';
import path from 'path';

// Minimal 1x1 pixel PNG base64
const minPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const buffer = Buffer.from(minPngBase64, 'base64');

const files = [
  'public/pwa-192x192.png',
  'public/pwa-512x512.png',
  'public/pwa-maskable-512x512.png',
  'public/apple-touch-icon.png',
  'public/favicon.ico'
];

files.forEach(file => {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, buffer);
  console.log(`Generated basic placeholder: ${file}`);
});
