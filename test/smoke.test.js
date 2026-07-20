const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const schemaPath = path.join(root, '..', 'an5Schema', 'test1.an5');

assert.ok(packageJson.scripts && packageJson.scripts.generate, 'Expected generate script');
assert.ok(packageJson.scripts && packageJson.scripts['db:push'], 'Expected db:push script');
assert.ok(fs.existsSync(path.join(root, 'generator', 'src', 'index.ts')), 'Expected generator entrypoint');
assert.ok(fs.existsSync(schemaPath), 'Expected sample schema file');

console.log('an5Orm smoke test passed');
