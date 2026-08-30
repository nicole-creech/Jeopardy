const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

console.log('Building CustomJeopardy.exe...');
execSync('npx --yes pkg server.js --targets node18-win-x64 --output dist/CustomJeopardy.exe', {
  cwd: root,
  stdio: 'inherit'
});

console.log('Copying public/ and games/ next to the exe...');
fs.cpSync(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true });
fs.mkdirSync(path.join(dist, 'games'), { recursive: true });
fs.copyFileSync(path.join(root, 'games', 'template.json'), path.join(dist, 'games', 'template.json'));

console.log(`Done. Distributable folder ready at: ${dist}`);
