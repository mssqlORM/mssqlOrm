/**
 * Release script for mssqlOrm workspace
 * Publishes all packages to NPM in the correct order.
 *
 * Usage:
 *   node scripts/release.js [patch|minor|major]
 *   node scripts/release.js --dry-run
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpType = args.find(a => ['patch', 'minor', 'major'].includes(a)) || 'patch';

const packages = [
  { name: 'mssql-orm', path: path.join(__dirname, '..') },
  { name: 'mssql-client', path: path.join(__dirname, '..', '..', 'mssqlClient') },
  { name: 'mssql-adapters', path: path.join(__dirname, '..', '..', 'mssqlAdapters') },
  { name: 'mssql-agent', path: path.join(__dirname, '..', '..', 'mssqlAgent') },
];

function run(cmd, cwd) {
  console.log(`  $ ${cmd}`);
  if (!dryRun) {
    execSync(cmd, { cwd, stdio: 'inherit' });
  }
}

function getVersion(pkgPath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf8'));
  return pkg.version;
}

function bumpVersion(version, type) {
  const parts = version.split('.').map(Number);
  if (type === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (type === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  return parts.join('.');
}

console.log('\n=== mssqlOrm Release ===\n');
console.log(`Bump type: ${bumpType}`);
console.log(`Dry run: ${dryRun}\n`);

for (const pkg of packages) {
  if (!fs.existsSync(path.join(pkg.path, 'package.json'))) {
    console.log(`⚠️  Skipping ${pkg.name} (no package.json)`);
    continue;
  }

  const currentVersion = getVersion(pkg.path);
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`\n📦 ${pkg.name}: ${currentVersion} → ${newVersion}`);

  // Update version
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  pkgJson.version = newVersion;
  if (!dryRun) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }

  // Run tests
  console.log('  Running tests...');
  run('npm test', pkg.path);

  // Publish
  console.log('  Publishing...');
  run('npm publish --access public', pkg.path);

  console.log(`  ✅ ${pkg.name}@${newVersion} published`);
}

console.log('\n✅ Release complete!\n');
