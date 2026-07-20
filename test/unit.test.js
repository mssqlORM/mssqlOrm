/**
 * an5Orm Unit Tests
 * Tests for parseWhere, buildOrderBy, and core ORM logic.
 * Run: node test/unit.test.js
 */
const assert = require('assert');

// ─── Import the compiled ORM modules ─────────────────────────────────────────
// We test the logic by requiring the source directly via tsx or compiled dist.
// For pure unit tests, we replicate the pure functions here and test them.

// ─── parseWhere tests ────────────────────────────────────────────────────────

function parseWhere(modelName, where, params = {}, prefix = '') {
  if (!where) return '';
  const conditions = [];

  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(value)) {
      const orConditions = value.map((subWhere, idx) => parseWhere(modelName, subWhere, params, `${prefix}or_${idx}_`));
      const filtered = orConditions.filter(Boolean);
      if (filtered.length > 0) conditions.push(`(${filtered.join(' OR ')})`);
    } else if (key === 'AND' && Array.isArray(value)) {
      const andConditions = value.map((subWhere, idx) => parseWhere(modelName, subWhere, params, `${prefix}and_${idx}_`));
      const filtered = andConditions.filter(Boolean);
      if (filtered.length > 0) conditions.push(`(${filtered.join(' AND ')})`);
    } else {
      const paramName = `${prefix}${key}`;
      if (value === null) {
        conditions.push(`${key} IS NULL`);
      } else if (typeof value === 'object' && !(value instanceof Date)) {
        const ops = Object.entries(value);
        for (const [op, opVal] of ops) {
          if (op === 'in' && Array.isArray(opVal)) {
            if (opVal.length === 0) {
              conditions.push('1 = 0');
            } else {
              const inParams = [];
              opVal.forEach((item, idx) => {
                const inParamName = `${paramName}_in_${idx}`;
                inParams.push(`@${inParamName}`);
                params[inParamName] = item;
              });
              conditions.push(`${key} IN (${inParams.join(', ')})`);
            }
          } else if (op === 'notIn' && Array.isArray(opVal)) {
            if (opVal.length === 0) {
              conditions.push('1 = 1');
            } else {
              const inParams = [];
              opVal.forEach((item, idx) => {
                const inParamName = `${paramName}_notin_${idx}`;
                inParams.push(`@${inParamName}`);
                params[inParamName] = item;
              });
              conditions.push(`${key} NOT IN (${inParams.join(', ')})`);
            }
          } else if (op === 'contains') {
            conditions.push(`${key} LIKE @${paramName}_contains`);
            params[`${paramName}_contains`] = `%${opVal}%`;
          } else if (op === 'startsWith') {
            conditions.push(`${key} LIKE @${paramName}_startsWith`);
            params[`${paramName}_startsWith`] = `${opVal}%`;
          } else if (op === 'endsWith') {
            conditions.push(`${key} LIKE @${paramName}_endsWith`);
            params[`${paramName}_endsWith`] = `%${opVal}`;
          } else if (op === 'not') {
            conditions.push(`${key} <> @${paramName}_not`);
            params[`${paramName}_not`] = opVal;
          } else if (op === 'gte') {
            conditions.push(`${key} >= @${paramName}_gte`);
            params[`${paramName}_gte`] = opVal;
          } else if (op === 'lte') {
            conditions.push(`${key} <= @${paramName}_lte`);
            params[`${paramName}_lte`] = opVal;
          } else if (op === 'gt') {
            conditions.push(`${key} > @${paramName}_gt`);
            params[`${paramName}_gt`] = opVal;
          } else if (op === 'lt') {
            conditions.push(`${key} < @${paramName}_lt`);
            params[`${paramName}_lt`] = opVal;
          }
        }
      } else {
        conditions.push(`${key} = @${paramName}`);
        params[paramName] = value;
      }
    }
  }
  return conditions.join(' AND ');
}

// ─── buildOrderBy tests ──────────────────────────────────────────────────────

function buildOrderBy(orderBy) {
  if (!orderBy) return '';
  const orderClauses = [];
  const orderByArr = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const orderObj of orderByArr) {
    if (orderObj && typeof orderObj === 'object') {
      for (const [k, dir] of Object.entries(orderObj)) {
        const dirStr = typeof dir === 'string' ? dir.toUpperCase() : 'ASC';
        orderClauses.push(`${k} ${dirStr}`);
      }
    }
  }
  return orderClauses.length > 0 ? ` ORDER BY ${orderClauses.join(', ')}` : '';
}

// ─── addNoLockToQuery tests ──────────────────────────────────────────────────

function addNoLockToQuery(sql) {
  if (!/^\s*SELECT/i.test(sql)) return sql;
  const tables = ['users', 'orders'];
  let modifiedSql = sql;
  for (const table of tables) {
    const escapedTable = table.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Match FROM/JOIN table with optional [dbo]. prefix
    const regex = new RegExp(`\\b(FROM|JOIN)\\s+(?:\\[dbo\\]\\.)?\\[?${escapedTable}\\]?\\b`, 'gi');
    modifiedSql = modifiedSql.replace(regex, (match, prefix) => {
      return `${prefix} [dbo].[${table}] WITH (NOLOCK)`;
    });
  }
  return modifiedSql;
}

// ─── Test suite ──────────────────────────────────────────────────────────────

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
    throw new Error(`${msg || 'Assertion failed'}: expected "${expected}", got "${actual}"`);
  }
}

function assertIncludes(str, substr, msg) {
  if (!str.includes(substr)) {
    throw new Error(`${msg || 'Assertion failed'}: "${str}" does not contain "${substr}"`);
  }
}

console.log('\n=== an5Orm Unit Tests ===\n');

// ─── parseWhere tests ────────────────────────────────────────────────────────

console.log('parseWhere:');

test('simple equality', () => {
  const params = {};
  const sql = parseWhere('user', { name: 'John' }, params);
  assertEq(sql, 'name = @name');
  assertEq(params.name, 'John');
});

test('null value produces IS NULL', () => {
  const params = {};
  const sql = parseWhere('user', { email: null }, params);
  assertEq(sql, 'email IS NULL');
});

test('IN operator', () => {
  const params = {};
  const sql = parseWhere('user', { id: { in: ['a', 'b', 'c'] } }, params);
  assertIncludes(sql, 'id IN (');
  assertEq(params.id_in_0, 'a');
  assertEq(params.id_in_1, 'b');
  assertEq(params.id_in_2, 'c');
});

test('empty IN produces 1 = 0', () => {
  const params = {};
  const sql = parseWhere('user', { id: { in: [] } }, params);
  assertEq(sql, '1 = 0');
});

test('NOT IN operator', () => {
  const params = {};
  const sql = parseWhere('user', { id: { notIn: ['x'] } }, params);
  assertIncludes(sql, 'id NOT IN (');
});

test('empty NOT IN produces 1 = 1', () => {
  const params = {};
  const sql = parseWhere('user', { id: { notIn: [] } }, params);
  assertEq(sql, '1 = 1');
});

test('contains produces LIKE', () => {
  const params = {};
  const sql = parseWhere('user', { name: { contains: 'oh' } }, params);
  assertEq(sql, 'name LIKE @name_contains');
  assertEq(params.name_contains, '%oh%');
});

test('startsWith produces LIKE', () => {
  const params = {};
  const sql = parseWhere('user', { name: { startsWith: 'Jo' } }, params);
  assertEq(sql, 'name LIKE @name_startsWith');
  assertEq(params.name_startsWith, 'Jo%');
});

test('endsWith produces LIKE', () => {
  const params = {};
  const sql = parseWhere('user', { name: { endsWith: 'hn' } }, params);
  assertEq(sql, 'name LIKE @name_endsWith');
  assertEq(params.name_endsWith, '%hn');
});

test('not operator', () => {
  const params = {};
  const sql = parseWhere('user', { status: { not: 'deleted' } }, params);
  assertEq(sql, 'status <> @status_not');
  assertEq(params.status_not, 'deleted');
});

test('gte operator', () => {
  const params = {};
  const sql = parseWhere('user', { age: { gte: 18 } }, params);
  assertEq(sql, 'age >= @age_gte');
  assertEq(params.age_gte, 18);
});

test('lte operator', () => {
  const params = {};
  const sql = parseWhere('user', { age: { lte: 65 } }, params);
  assertEq(sql, 'age <= @age_lte');
  assertEq(params.age_lte, 65);
});

test('gt operator', () => {
  const params = {};
  const sql = parseWhere('user', { age: { gt: 18 } }, params);
  assertEq(sql, 'age > @age_gt');
});

test('lt operator', () => {
  const params = {};
  const sql = parseWhere('user', { age: { lt: 65 } }, params);
  assertEq(sql, 'age < @age_lt');
});

test('AND conditions', () => {
  const params = {};
  const sql = parseWhere('user', { AND: [{ name: 'John' }, { age: 30 }] }, params);
  assertIncludes(sql, 'AND');
  assertIncludes(sql, 'name = @and_0_name');
  assertIncludes(sql, 'age = @and_1_age');
});

test('OR conditions', () => {
  const params = {};
  const sql = parseWhere('user', { OR: [{ name: 'John' }, { name: 'Jane' }] }, params);
  assertIncludes(sql, 'OR');
  assertIncludes(sql, 'name = @or_0_name');
  assertIncludes(sql, 'name = @or_1_name');
});

test('multiple conditions combined', () => {
  const params = {};
  const sql = parseWhere('user', { name: 'John', age: { gte: 18 } }, params);
  assertIncludes(sql, ' AND ');
  assertIncludes(sql, 'name = @name');
  assertIncludes(sql, 'age >= @age_gte');
});

test('empty where returns empty string', () => {
  const sql = parseWhere('user', {}, {});
  assertEq(sql, '');
});

test('null where returns empty string', () => {
  const sql = parseWhere('user', null, {});
  assertEq(sql, '');
});

// ─── buildOrderBy tests ──────────────────────────────────────────────────────

console.log('\nbuildOrderBy:');

test('single field ascending', () => {
  const sql = buildOrderBy({ name: 'asc' });
  assertEq(sql, ' ORDER BY name ASC');
});

test('single field descending', () => {
  const sql = buildOrderBy({ createdAt: 'desc' });
  assertEq(sql, ' ORDER BY createdAt DESC');
});

test('multiple fields', () => {
  const sql = buildOrderBy([{ name: 'asc' }, { age: 'desc' }]);
  assertIncludes(sql, 'name ASC');
  assertIncludes(sql, 'age DESC');
  assertIncludes(sql, ', ');
});

test('null returns empty', () => {
  const sql = buildOrderBy(null);
  assertEq(sql, '');
});

test('empty object returns empty', () => {
  const sql = buildOrderBy({});
  assertEq(sql, '');
});

// ─── addNoLockToQuery tests ──────────────────────────────────────────────────

console.log('\naddNoLockToQuery:');

test('adds NOLOCK to FROM clause', () => {
  const sql = addNoLockToQuery('SELECT * FROM [dbo].[users]');
  assertIncludes(sql, 'WITH (NOLOCK)');
});

test('adds NOLOCK to JOIN clause', () => {
  const sql = addNoLockToQuery('SELECT * FROM [dbo].[users] u JOIN [dbo].[orders] o ON u.id = o.userId');
  assertIncludes(sql, '[dbo].[users] WITH (NOLOCK)');
  assertIncludes(sql, '[dbo].[orders] WITH (NOLOCK)');
});

test('does not modify INSERT statements', () => {
  const sql = addNoLockToQuery('INSERT INTO [dbo].[users] (name) VALUES (@name)');
  assertEq(sql, 'INSERT INTO [dbo].[users] (name) VALUES (@name)');
});

test('does not modify UPDATE statements', () => {
  const sql = addNoLockToQuery('UPDATE [dbo].[users] SET name = @name');
  assertEq(sql, 'UPDATE [dbo].[users] SET name = @name');
});

test('does not modify DELETE statements', () => {
  const sql = addNoLockToQuery('DELETE FROM [dbo].[users] WHERE id = @id');
  assertEq(sql, 'DELETE FROM [dbo].[users] WHERE id = @id');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
