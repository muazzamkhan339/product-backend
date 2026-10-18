// Builds an update package for Super Admin -> Updates -> Create Update.
// Usage: node server/tools/make-update.js <output.json> <file> [<file> ...]
// Each file must live inside the project's app/ folder; it is stored at the same relative path.
const fs = require('fs');
const path = require('path');

const [, , outFile, ...inputs] = process.argv;
if (!outFile || !inputs.length) {
  console.error('Usage: node server/tools/make-update.js <output.json> <file> [<file> ...]');
  process.exit(1);
}
const appDir = path.resolve(__dirname, '..', '..', 'app');
const files = inputs.map(f => {
  const abs = path.resolve(f);
  if (!abs.startsWith(appDir + path.sep)) throw new Error('File must be inside the app/ folder: ' + f);
  const rel = path.relative(path.resolve(__dirname, '..', '..'), abs).split(path.sep).join('/');
  return { path: rel, encoding: 'base64', content: fs.readFileSync(abs).toString('base64') };
});
fs.writeFileSync(outFile, JSON.stringify({ format: 'hps-update-1', files }, null, 2));
console.log('Wrote ' + outFile + ' with ' + files.length + ' file(s):');
files.forEach(f => console.log('  ' + f.path));
