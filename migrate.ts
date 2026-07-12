/**
 * mssqlOrm Migration Tool
 * Compares schema files with database and generates migration SQL.
 *
 * Usage:
 *   npx tsx migrate.ts diff       # Show differences
 *   npx tsx migrate.ts generate   # Generate migration file
 *   npx tsx migrate.ts status     # Show migration status
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { MssqlAdapter } from 'mssql-adapters';

const rootDir = path.join(__dirname, '../');
let config: any = {};
try {
  const configPath = path.join(rootDir, 'mssqlOrm.config.js');
  if (fs.existsSync(configPath)) {
    config = require(configPath);
  }
} catch { /* ignore */ }

const schemaDir = path.resolve(rootDir, config.schemaDir || 'mssqlSchema');
const migrationsDir = path.resolve(rootDir, 'migrations');

let _adapter: MssqlAdapter | null = null;
async function getDb(): Promise<MssqlAdapter> {
  if (!_adapter) {
    _adapter = new MssqlAdapter({ connectionString: process.env.DATABASE_URL! });
    await _adapter.$connect();
  }
  return _adapter;
}

// ─── Supported SQL Server Types ──────────────────────────────────────────────

const MSSQL_TYPES = new Set([
  'NVARCHAR', 'VARCHAR', 'CHAR', 'NCHAR', 'TEXT', 'NTEXT', 'XML',
  'INT', 'SMALLINT', 'TINYINT', 'BIGINT', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC',
  'MONEY', 'SMALLMONEY', 'BIT',
  'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATE', 'TIME', 'DATETIMEOFFSET',
  'VARBINARY', 'BINARY', 'IMAGE',
  'UNIQUEIDENTIFIER', 'SQL_VARIANT', 'ROWVERSION',
  'HIERARCHYID', 'GEOGRAPHY', 'GEOMETRY', 'VECTOR',
]);

function parseSqlType(raw: string): string {
  const match = raw.match(/^(\w+)/);
  return match ? match[1].toUpperCase() : raw.toUpperCase();
}

// ─── Schema Parser ───────────────────────────────────────────────────────────

interface SchemaField {
  name: string;
  sqlType: string;    // Full SQL type like "NVARCHAR(255)"
  isOptional: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultValue?: string;
}

interface SchemaModel {
  name: string;
  tableName: string;
  fields: SchemaField[];
  compoundUniques: string[][];
  indexes: string[][];
}

function parseSchema(): SchemaModel[] {
  const models: SchemaModel[] = [];
  if (!fs.existsSync(schemaDir)) return models;

  const files = fs.readdirSync(schemaDir).filter(f => f.endsWith('.mssql'));
  let text = '';
  for (const file of files) {
    text += fs.readFileSync(path.join(schemaDir, file), 'utf8') + '\n';
  }

  const lines = text.split('\n');
  let current: SchemaModel | null = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;

    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      current = {
        name: modelMatch[1],
        tableName: modelMatch[1].toLowerCase() + 's',
        fields: [],
        compoundUniques: [],
        indexes: [],
      };
      models.push(current);
      continue;
    }

    if (line === '}') { current = null; continue; }
    if (!current) continue;

    if (line.startsWith('@@map')) {
      const m = line.match(/@@map\("(.+)"\)/);
      if (m) current.tableName = m[1];
      continue;
    }
    if (line.startsWith('@@unique')) {
      const m = line.match(/@@unique\(\[([\w,\s]+)\]\)/);
      if (m) current.compoundUniques.push(m[1].split(',').map(f => f.trim()));
      continue;
    }
    if (line.startsWith('@@index')) {
      const m = line.match(/@@index\(\[([\w,\s]+)\]\)/);
      if (m) current.indexes.push(m[1].split(',').map(f => f.trim()));
      continue;
    }
    if (line.startsWith('@@')) continue;

    const parts = line.split(/\s+/);
    const fieldName = parts[0];
    const fieldType = parts[1];
    if (!fieldName || !fieldType) continue;

    // Parse SQL Server type directly
    const cleanType = fieldType.replace('[]', '').replace('?', '');
    const sqlBase = parseSqlType(cleanType);

    // Skip if not a known SQL Server type (might be a relation)
    if (!MSSQL_TYPES.has(sqlBase)) continue;

    current.fields.push({
      name: fieldName,
      sqlType: cleanType.toUpperCase(),
      isOptional: fieldType.endsWith('?'),
      isId: line.includes('@id'),
      isUnique: line.includes('@unique'),
      defaultValue: line.match(/@default\((.*)\)/)?.[1],
    });
  }

  return models;
}

// ─── Database Introspection ──────────────────────────────────────────────────

interface DbColumn {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  defaultValue?: string;
}

async function introspectTable(tableName: string): Promise<DbColumn[]> {
  return (await getDb()).$queryRawUnsafe<DbColumn[]>(`
    SELECT
      c.name AS columnName,
      ty.name AS dataType,
      c.is_nullable AS isNullable,
      pk.is_primary_key AS isPrimaryKey,
      c.is_identity AS isIdentity,
      d.definition AS defaultValue
    FROM sys.columns c
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    LEFT JOIN (
      SELECT ic.object_id, ic.column_id, i.is_primary_key
      FROM sys.index_columns ic
      JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.is_primary_key = 1
    ) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
    LEFT JOIN sys.default_constraints d ON c.default_object_id = d.object_id
    WHERE c.object_id = OBJECT_ID(@p_0)
    ORDER BY c.column_id
  `, tableName);
}

async function getExistingTables(): Promise<string[]> {
  const rows = await (await getDb()).$queryRawUnsafe<{ name: string }[]>(`
    SELECT name FROM sys.tables WHERE is_ms_shipped = 0 ORDER BY name
  `);
  return rows.map(r => r.name);
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

interface MigrationOp {
  type: 'CREATE_TABLE' | 'ADD_COLUMN' | 'DROP_COLUMN' | 'ALTER_COLUMN' | 'ADD_INDEX' | 'DROP_INDEX';
  table: string;
  column?: string;
  details?: string;
  sql?: string;
}

function generateDiff(schemaModels: SchemaModel[], dbTables: string[]): MigrationOp[] {
  const ops: MigrationOp[] = [];
  const schemaTableNames = new Set(schemaModels.map(m => m.tableName));

  // New tables
  for (const model of schemaModels) {
    if (!dbTables.includes(model.tableName)) {
      const colDefs = model.fields.map(f => {
        let def = `[${f.name}] ${f.sqlType}`;
        if (f.isId) def += ' PRIMARY KEY';
        if (f.defaultValue) def += ` ${mapDefault(f.defaultValue)}`;
        if (!f.isOptional && !f.defaultValue && !f.isId) def += ' NOT NULL';
        if (f.isUnique && !f.isId) def += ' UNIQUE';
        return def;
      });

      const sql = `CREATE TABLE [${model.tableName}] (\n  ${colDefs.join(',\n  ')}\n)`;
      ops.push({ type: 'CREATE_TABLE', table: model.tableName, sql });
    }
  }

  // Dropped tables
  for (const tableName of dbTables) {
    if (!schemaTableNames.has(tableName)) {
      ops.push({
        type: 'DROP_COLUMN',
        table: tableName,
        details: `Table not in schema - consider dropping`,
        sql: `-- DROP TABLE [${tableName}]`,
      });
    }
  }

  return ops;
}

function mapDefault(val: string): string {
  if (val === 'uuid()') return 'DEFAULT NEWID()';
  if (val === 'cuid()') return 'DEFAULT NEWID()';
  if (val === 'now()') return 'DEFAULT CURRENT_TIMESTAMP';
  if (val === 'autoincrement()') return 'IDENTITY(1,1)';
  if (val === 'true') return 'DEFAULT 1';
  if (val === 'false') return 'DEFAULT 0';
  if (/^".*"$/.test(val)) return `DEFAULT '${val.slice(1, -1)}'`;
  return `DEFAULT ${val}`;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdDiff() {
  console.log('\n🔍 Comparing schema with database...\n');

  const schemaModels = parseSchema();
  const dbTables = await getExistingTables();

  console.log(`Schema: ${schemaModels.length} models`);
  console.log(`Database: ${dbTables.length} tables\n`);

  const ops = generateDiff(schemaModels, dbTables);

  if (ops.length === 0) {
    console.log('✅ Schema is in sync with database.');
    return;
  }

  console.log(`Found ${ops.length} difference(s):\n`);
  for (const op of ops) {
    console.log(`  ${op.type}: ${op.table}`);
    if (op.details) console.log(`    ${op.details}`);
    if (op.sql) console.log(`    SQL: ${op.sql}`);
  }
}

async function cmdGenerate() {
  console.log('\n📝 Generating migration file...\n');

  const schemaModels = parseSchema();
  const dbTables = await getExistingTables();
  const ops = generateDiff(schemaModels, dbTables);

  if (ops.length === 0) {
    console.log('No migrations needed.');
    return;
  }

  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${timestamp}_migration.sql`;
  const filepath = path.join(migrationsDir, filename);

  const lines = [`-- Migration: ${timestamp}`, `-- Generated by mssqlOrm migrate`, ''];

  for (const op of ops) {
    lines.push(`-- ${op.type}: ${op.table}`);
    if (op.sql) lines.push(op.sql);
    lines.push('');
  }

  fs.writeFileSync(filepath, lines.join('\n'));
  console.log(`✅ Migration written to: ${filepath}`);
}

async function cmdStatus() {
  console.log('\n📊 Migration Status\n');

  const schemaModels = parseSchema();
  const dbTables = await getExistingTables();

  console.log('Schema Models:');
  for (const model of schemaModels) {
    const exists = dbTables.includes(model.tableName);
    const icon = exists ? '✅' : '⚠️';
    console.log(`  ${icon} ${model.name} → ${model.tableName} (${model.fields.length} fields)`);
  }

  console.log('\nDatabase Tables:');
  for (const table of dbTables) {
    const inSchema = schemaModels.some(m => m.tableName === table);
    const icon = inSchema ? '✅' : '⚠️';
    console.log(`  ${icon} ${table}`);
  }

  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }
  const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
  console.log(`\nMigration files: ${migrations.length}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2] || 'diff';

  switch (command) {
    case 'diff': await cmdDiff(); break;
    case 'generate': await cmdGenerate(); break;
    case 'status': await cmdStatus(); break;
    default:
      console.log('Usage: npx tsx migrate.ts [diff|generate|status]');
      process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
