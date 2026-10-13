import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createRooql, loadOssieModel } from '../src/index.js';
import { valueLiteral } from '../src/literals.js';

const field = (name, datatype, expression = name) => ({ name, expression, datatype });
const document = metrics => ({
  version: '0.2.0.dev0', name: 'safety',
  datasets: [{ name: 'events', source: 'events', fields: [field('id', 'Integer'), field('d', 'Date'), field('s', 'String'), field('nullable', 'String'), field('n', 'Decimal')] }],
  metrics: Object.entries(metrics).map(([name, expression]) => ({ name, expression })),
});
const load = doc => loadOssieModel(JSON.stringify(doc));
const compiler = async (doc, dialect = 'duckdb') => createRooql({ model: await load(doc), dialect });
const db = await (await DuckDBInstance.create(':memory:')).connect();
after(() => db.closeSync());
await db.run(`CREATE TABLE events AS SELECT * FROM (VALUES
  (1, DATE '2026-01-04', 'x', NULL, 1.5), (2, DATE '2026-01-05', 'y', 'z', 2.0)
) t(id, d, s, nullable, n)`);
const rows = async sql => (await db.runAndReadAll(sql)).getRowObjectsJson();

test('DuckDB DATEADD retains sub-day time and its inferred type, including nested calls', async () => {
  for (const [unit, expected, datatype] of [
    ['hour', '2026-01-04 02:00:00', 'DateTime'], ['minute', '2026-01-04 00:02:00', 'DateTime'],
    ['second', '2026-01-04 00:00:02', 'DateTime'], ['day', '2026-01-06', 'Date'], ['month', '2026-03-04', 'Date'],
  ]) {
    const c = await compiler(document({ m: `MIN(DATEADD(${unit}, 2, events.d))` }));
    const result = c.compile({ metrics: ['m'] });
    assert.deepEqual(await rows(result.sql), [{ m0: expected }]);
    assert.equal(result.columns[0].datatype, datatype);
  }
  const doc = document({ m: 'COUNT(events.id)' });
  doc.datasets[0].fields.push({ name: 'later', expression: 'DATEADD(day, 1, DATEADD(hour, 2, d))' });
  const c = await compiler(doc);
  const q = c.compile({ metrics: ['m'], filters: [{ field: 'events.later', operator: 'eq', value: '2026-01-05 02:00:00' }] });
  assert.deepEqual(await rows(q.sql), [{ m0: '1' }]);
});

test('CONCAT propagates NULL and preserves empty and single-argument strings', async () => {
  const c = await compiler(document({ m: 'COUNT(CONCAT(events.s, events.nullable))', single: 'MIN(CONCAT(42))', empty: "MIN(CONCAT('', 'x', ''))", missing: 'MIN(CONCAT(NULL))' }));
  assert.deepEqual(await rows(c.compile({ metrics: ['m', 'single', 'empty', 'missing'] }).sql), [{ m0: '1', m1: '42', m2: 'x', m3: null }]);
});

test('week differences count Monday boundaries in both directions and across years', async () => {
  for (const [start, end, expected] of [
    ['2026-01-04', '2026-01-05', '1'], ['2026-01-05', '2026-01-04', '-1'],
    ['2025-12-28', '2026-01-05', '2'], ['2026-01-05', '2026-01-11', '0'],
  ]) {
    const doc = document({ m: `MIN(DATEDIFF(week, DATE '${start}', DATE '${end}'))` });
    assert.deepEqual(await rows((await compiler(doc)).compile({ metrics: ['m'] }).sql), [{ m0: expected }]);
    const snow = (await compiler(doc, 'snowflake')).compile({ metrics: ['m'] }).sql;
    assert.match(snow, /DAYOFWEEKISO/);
    assert.doesNotMatch(snow, /DATEDIFF\(week|DATE_TRUNC\('week'/);
  }
});

test('timestamp casts preserve NTZ intent and Snowflake TRY_CAST rejects non-string sources', async () => {
  const doc = document({ m: "MIN(CAST('2026-01-01 12:00:00' AS TIMESTAMP_NTZ))", n: 'SUM(TRY_CAST(events.n AS INTEGER))', text: 'MIN(TRY_CAST(events.s AS INTEGER))' });
  const snow = await compiler(doc, 'snowflake');
  assert.match(snow.compile({ metrics: ['m'] }).sql, /AS TIMESTAMP_NTZ/);
  assert.throws(() => snow.compile({ metrics: ['n'] }), { code: 'UNSUPPORTED_EXPRESSION' });
  assert.match(snow.compile({ metrics: ['text'] }).sql, /TRY_CAST/);
  assert.deepEqual(await rows((await compiler(doc)).compile({ metrics: ['m'] }).sql), [{ m0: '2026-01-01 12:00:00' }]);
});

test('physical join keys cannot be replaced by same-named computed fields', async () => {
  await db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER)');
  await db.run('INSERT INTO orders VALUES (1, 1, 100), (2, 2, 200)');
  await db.run('CREATE TABLE customers (id INTEGER PRIMARY KEY, score INTEGER)');
  await db.run('INSERT INTO customers VALUES (1, 5), (2, 7)');
  const doc = {
    version: '0.2.0.dev0', name: 'keys',
    datasets: [
      { name: 'orders', source: 'orders', primary_key: ['id'], fields: [field('amount', 'Integer'), field('customer_id', 'Integer', '1')] },
      { name: 'customers', source: 'customers', primary_key: ['id'], fields: [field('id', 'Integer', '1'), field('score', 'Integer')] },
    ],
    relationships: [{ name: 'o_c', from: 'orders', to: 'customers', from_columns: ['customer_id'], to_columns: ['id'] }],
    metrics: [{ name: 'total', expression: 'SUM(orders.amount)' }, { name: 'max_score', expression: 'MAX(customers.score)' }],
  };
  const c = await compiler(doc);
  assert.deepEqual(await rows(c.compile({ metrics: ['total', 'max_score'] }).sql), [{ m0: '300', m1: 7 }]);
  for (const property of ['primary_key', 'unique_keys']) {
    const bad = structuredClone(doc);
    bad.datasets[0][property] = property === 'primary_key' ? ['id', 'ID'] : [['id', 'ID']];
    await assert.rejects(load(bad), { code: 'INVALID_SHAPE' });
  }
});

test('ambiguous one-to-one populations are refused in either dataset order', async () => {
  const doc = document({ a: 'COUNT(events.id)', b: 'SUM(profiles.points)' });
  doc.datasets[0].primary_key = ['id'];
  doc.datasets.push({ name: 'profiles', source: 'profiles', primary_key: ['id'], fields: [field('id', 'Integer'), field('points', 'Integer')] });
  doc.relationships = [{ name: 'p_e', from: 'profiles', to: 'events', from_columns: ['id'], to_columns: ['id'] }];
  for (let i = 0; i < 2; i++) {
    const c = await compiler(doc);
    assert.throws(() => c.compile({ metrics: ['a', 'b'] }), { code: 'AMBIGUOUS_ANCHOR' });
    // A single metric still anchors its own dataset, regardless of dimension order.
    assert.match(c.compile({ metrics: ['b'], dimensions: ['events.d'] }).sql, /FROM "PROFILES"/);
    doc.datasets.reverse();
  }
});

test('malformed query values fail with typed errors before SQL execution', async () => {
  const c = await compiler(document({ m: 'COUNT(events.id)' }));
  for (const direction of [1, false, {}, [], null]) {
    assert.throws(() => c.compile({ metrics: ['m'], orderBy: [{ field: 'm', direction }] }), { code: 'INVALID_QUERY' });
  }
  assert.throws(() => c.compile({ metrics: ['m'], filters: [{ field: 'events.n', operator: 'like', value: '1%' }] }), { code: 'UNSUPPORTED_OPERATOR' });
  await assert.rejects(load(document({ m: 'MIN(DATEADD(day, events.n, events.d))' })), { code: 'UNSUPPORTED_EXPRESSION' });
});

test('temporal filters validate leap years, clock fields, and offset ranges', () => {
  for (const dialect of ['duckdb', 'snowflake']) {
    for (const [value, type] of [['2026-02-30', 'Date'], ['1900-02-29', 'Date'], ['2026-01-01 24:00', 'DateTime'], ['12:60:00', 'Time'], ['2026-01-01T12:00:00+25:00', 'DateTimeTz']]) {
      assert.throws(() => valueLiteral(value, type, dialect), { code: 'INVALID_FILTER_VALUE' });
    }
    assert.equal(valueLiteral('2000-02-29', 'Date', dialect), "DATE '2000-02-29'");
    assert.match(valueLiteral('2026-01-01T12:00:00+05:30', 'DateTimeTz', dialect), /CAST/);
  }
});

test('reference expansion and dependency depth have typed bounds', async () => {
  const doc = document({});
  doc.metrics = Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, expression: i ? `m${i - 1} + m${i - 1}` : 'COUNT(*)' }));
  await assert.rejects(load(doc), { code: 'EXPRESSION_TOO_COMPLEX' });
  doc.metrics = [{ name: 'm', expression: 'COUNT(events.f0)' }];
  doc.datasets[0].fields = Array.from({ length: 3000 }, (_, i) => ({ name: `f${i}`, expression: i === 2999 ? 'id' : `events.f${i + 1}` }));
  await assert.rejects(load(doc), { code: 'EXPRESSION_TOO_COMPLEX' });
});

test('SQL output is bounded even when a small tree repeats long literals', async () => {
  const doc = document({ m: `MIN(CONCAT('${'x'.repeat(9000)}', events.s))` });
  for (let i = 0; i < 7; i++) doc.metrics.push({ name: `m${i}`, expression: `CONCAT(${i ? `m${i - 1}` : 'm'}, ${i ? `m${i - 1}` : 'm'})` });
  const c = await compiler(doc);
  assert.throws(() => c.compile({ metrics: ['m6'] }), { code: 'QUERY_TOO_COMPLEX' });
});
