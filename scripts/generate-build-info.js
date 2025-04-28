// scripts/generate-build-info.js
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'node:module'; // Use node: prefix for clarity
import { fileURLToPath } from 'node:url'; // Import fileURLToPath

// Since package.json is JSON, we need createRequire to import it in ES Modules
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

// Get version from package.json
const version = packageJson.version;

// Get git commit hash
let commitHash = '';
try {
  // Get short hash (first 7 characters)
  commitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch (error) {
  console.error('Error getting git commit hash:', error);
  // Provide a fallback value if git command fails (e.g., in environments without git)
  commitHash = 'nogit';
}

// Create build info object
const buildInfo = {
  version,
  commitHash,
  buildDate: new Date().toISOString()
};

// Create directory if it doesn't exist
// Calculate __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dir = path.join(__dirname, '../src/generated');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write to file
fs.writeFileSync(
  path.join(dir, 'build-info.json'),
  JSON.stringify(buildInfo, null, 2)
);

console.log('Build info generated:', buildInfo);
