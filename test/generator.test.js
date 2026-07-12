/**
 * mssqlOrm Generator Unit Tests
 * Tests for schema parser and code generation.
 * Run: node test/generator.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assert'}: expected "${expected}", got "${actual}"`);
  }
}

function assertIncludes(str, substr, msg) {
  if (!str || !str.includes(substr)) {
    throw new Error(`${msg || 'Assert'}: "${str}" does not contain "${substr}"`);
  }
}

function assertExists(filePath, msg) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${msg || 'Assert'}: file not found: ${filePath}`);
  }
}

console.log('\n=== Generator Unit Tests ===\n');

// ─── Schema file tests ───────────────────────────────────────────────────────

console.log('Schema Files:');

test('test1.mssql exists and is valid', () => {
  const schemaPath = path.join(__dirname, '..', '..', 'mssqlSchema', 'test1.mssql');
  assertExists(schemaPath);
  const content = fs.readFileSync(schemaPath, 'utf8');
  assertIncludes(content, 'model User');
  assertIncludes(content, 'id');
  assertIncludes(content, 'email');
  assertIncludes(content, 'NVARCHAR');
  assertIncludes(content, 'DATETIME2');
});

test('test2.mssql exists and has Order model', () => {
  const schemaPath = path.join(__dirname, '..', '..', 'mssqlSchema', 'test2.mssql');
  assertExists(schemaPath);
  const content = fs.readFileSync(schemaPath, 'utf8');
  assertIncludes(content, 'model Order');
  assertIncludes(content, 'INT');
});

test('schema files parse model headers correctly', () => {
  const schemaPath = path.join(__dirname, '..', '..', 'mssqlSchema', 'test1.mssql');
  const content = fs.readFileSync(schemaPath, 'utf8');
  const modelMatch = content.match(/model\s+(\w+)\s*\{/);
  assertEq(modelMatch[1], 'User');
});

test('schema files use SQL Server types directly', () => {
  const schemaPath = path.join(__dirname, '..', '..', 'mssqlSchema', 'test1.mssql');
  const content = fs.readFileSync(schemaPath, 'utf8');
  assertIncludes(content, 'NVARCHAR(');
  assertIncludes(content, 'DATETIME2');
  // Should NOT have Prisma-like types
  assert(!content.includes('String '), 'Should not use Prisma-like String type');
  assert(!content.includes('DateTime '), 'Should not use Prisma-like DateTime type');
});

// ─── Generator source tests ──────────────────────────────────────────────────

console.log('\nGenerator Source:');

test('parser.ts exists', () => {
  const parserPath = path.join(__dirname, '..', 'generator', 'src', 'parser.ts');
  assertExists(parserPath);
});

test('code-generator.ts exists', () => {
  const genPath = path.join(__dirname, '..', 'generator', 'src', 'code-generator.ts');
  assertExists(genPath);
});

test('metadata-generator.ts exists', () => {
  const metaPath = path.join(__dirname, '..', 'generator', 'src', 'metadata-generator.ts');
  assertExists(metaPath);
});

test('python-generator.ts exists', () => {
  const pyPath = path.join(__dirname, '..', 'generator', 'src', 'python-generator.ts');
  assertExists(pyPath);
});

test('dotnet-generator.ts exists', () => {
  const dotnetPath = path.join(__dirname, '..', 'generator', 'src', 'dotnet-generator.ts');
  assertExists(dotnetPath);
});

test('types.ts exists with Model and Field interfaces', () => {
  const typesPath = path.join(__dirname, '..', 'generator', 'src', 'types.ts');
  assertExists(typesPath);
  const content = fs.readFileSync(typesPath, 'utf8');
  assertIncludes(content, 'Model');
  assertIncludes(content, 'Field');
});

test('generator index.ts has main function', () => {
  const indexPath = path.join(__dirname, '..', 'generator', 'src', 'index.ts');
  assertExists(indexPath);
  const content = fs.readFileSync(indexPath, 'utf8');
  assertIncludes(content, 'SchemaParser');
  assertIncludes(content, 'CodeGenerator');
  assertIncludes(content, 'MetadataGenerator');
});

// ─── Generated output tests ──────────────────────────────────────────────────

console.log('\nGenerated Output:');

test('mssqlClient/typescript/index.ts exists', () => {
  const indexPath = path.join(__dirname, '..', '..', 'mssqlClient', 'typescript', 'index.ts');
  assertExists(indexPath);
});

test('mssqlClient/typescript/base.ts exists with Mssql namespace', () => {
  const basePath = path.join(__dirname, '..', '..', 'mssqlClient', 'typescript', 'base.ts');
  assertExists(basePath);
  const content = fs.readFileSync(basePath, 'utf8');
  assertIncludes(content, 'namespace Mssql');
  assertIncludes(content, 'MssqlClientKnownRequestError');
});

test('mssqlClient/typescript/mssqlMetadata.ts exists', () => {
  const metaPath = path.join(__dirname, '..', '..', 'mssqlClient', 'typescript', 'mssqlMetadata.ts');
  assertExists(metaPath);
  const content = fs.readFileSync(metaPath, 'utf8');
  assertIncludes(content, 'modelToTable');
  assertIncludes(content, 'relationMap');
  assertIncludes(content, 'modelFields');
});

test('mssqlClient/python/mssql_metadata.py exists', () => {
  const pyPath = path.join(__dirname, '..', '..', 'mssqlClient', 'python', 'mssql_metadata.py');
  assertExists(pyPath);
  const content = fs.readFileSync(pyPath, 'utf8');
  assertIncludes(content, 'MODEL_TO_TABLE');
  assertIncludes(content, 'MODEL_FIELDS');
});

test('mssqlClient/dotnet files exist', () => {
  const dotnetDir = path.join(__dirname, '..', '..', 'mssqlClient', 'dotnet');
  assertExists(path.join(dotnetDir, 'User.cs'));
  assertExists(path.join(dotnetDir, 'Order.cs'));
  assertExists(path.join(dotnetDir, 'MssqlDbContext.cs'));
});

// ─── ORM core file tests ─────────────────────────────────────────────────────

console.log('\nORM Core:');

test('mssqlOrm.ts exists with MssqlORM class', () => {
  const ormPath = path.join(__dirname, '..', 'mssqlOrm.ts');
  assertExists(ormPath);
  const content = fs.readFileSync(ormPath, 'utf8');
  assertIncludes(content, 'class MssqlORM');
  assertIncludes(content, 'class TableClient');
  assertIncludes(content, 'parseWhere');
  assertIncludes(content, 'buildOrderBy');
});

test('push.ts exists with push function', () => {
  const pushPath = path.join(__dirname, '..', 'push.ts');
  assertExists(pushPath);
  const content = fs.readFileSync(pushPath, 'utf8');
  assertIncludes(content, 'async function push');
  assertIncludes(content, 'CREATE TABLE');
});

test('pull.ts exists with pull function', () => {
  const pullPath = path.join(__dirname, '..', 'pull.ts');
  assertExists(pullPath);
  const content = fs.readFileSync(pullPath, 'utf8');
  assertIncludes(content, 'async function pull');
  assertIncludes(content, 'sys.tables');
});

test('seed.ts exists', () => {
  const seedPath = path.join(__dirname, '..', 'seed.ts');
  assertExists(seedPath);
});

test('cleanup.ts exists', () => {
  const cleanupPath = path.join(__dirname, '..', 'cleanup.ts');
  assertExists(cleanupPath);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
