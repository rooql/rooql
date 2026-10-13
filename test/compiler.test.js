import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRooql, loadOssieModel } from '../src/index.js';

const grossText = await readFile(new URL('./fixtures/revenue.model.json', import.meta.url), 'utf8');
const netText = await readFile(new URL('./fixtures/revenue-net.model.json', import.meta.url), 'utf8');
const gross = await loadOssieModel(grossText);
const compiler = createRooql({ model: gross, dialect: 'snowflake' });
const query = { metrics: ['revenue'], dimensions: ['orders.country'], filters: [{ field: 'orders.status', operator: 'eq', value: 'completed' }] };

test('demo query emits deterministic Snowflake SQL and ordered result mapping', () => {
  const result = compiler.compile(query);
  assert.equal(result.sql, `SELECT
  "t0"."COUNTRY" AS "d0",
  SUM("t0"."AMOUNT") AS "m0"
FROM "AGENT_DEMO"."PUBLIC"."ROOQL_ORDERS" AS "t0"
WHERE "t0"."STATUS" = 'completed'
GROUP BY "t0"."COUNTRY"`);
  assert.deepEqual(result.columns, [
    { alias: 'd0', kind: 'dimension', name: 'orders.country', datatype: 'String' },
    { alias: 'm0', kind: 'metric', name: 'revenue', datatype: 'Decimal' },
  ]);
  assert.equal(result.valueMode, 'inline');
  assert.equal(result.dialect, 'snowflake');
  assert.equal(result.modelHash, gross.modelHash);
  assert.equal(result.specRevision, gross.specRevision);
  assert.deepEqual(compiler.compile(query), result);
  assert.ok(Object.isFrozen(result.columns[0]));
});

test('reloading the definition changes SQL and hash while old compiler retains its snapshot', async () => {
  const net = await loadOssieModel(netText);
  const result = createRooql({ model: net, dialect: 'snowflake' }).compile(query);
  assert.match(result.sql, /SUM\(\("t0"\."AMOUNT" - "t0"\."REFUND_AMOUNT"\)\)/);
  assert.notEqual(result.modelHash, compiler.compile(query).modelHash);
  assert.match(compiler.compile(query).sql, /SUM\("t0"\."AMOUNT"\)/);
  assert.deepEqual(result.columns, compiler.compile(query).columns);
  assert.doesNotMatch(result.sql, /COALESCE/);
});

test('multiple dimensions and metrics preserve requested order with stable aliases', async () => {
  const document = JSON.parse(grossText);
  document.metrics.push({ name: 'orders_count', expression: { dialects: [{ dialect: 'OSSIE_SQL_2026', expression: 'COUNT(*)' }] } });
  document.metrics.push({ name: 'status_count', expression: { dialects: [{ dialect: 'OSSIE_SQL_2026', expression: 'COUNT(orders.status)' }] } });
  const model = await loadOssieModel(JSON.stringify(document));
  const result = createRooql({ model, dialect: 'snowflake' }).compile({ metrics: ['status_count', 'orders_count', 'REVENUE'], dimensions: ['ORDERS.STATUS', 'orders.country'] });
  assert.deepEqual(result.columns.map(({ alias, name }) => [alias, name]), [['d0', 'orders.status'], ['d1', 'orders.country'], ['m0', 'status_count'], ['m1', 'orders_count'], ['m2', 'revenue']]);
  assert.match(result.sql, /COUNT\("t0"\."STATUS"\) AS "m0"/);
  assert.match(result.sql, /COUNT\(\*\) AS "m1"/);
  assert.match(result.sql, /GROUP BY "t0"\."STATUS", "t0"\."COUNTRY"$/);
  assert.doesNotMatch(compiler.compile({ metrics: ['revenue'] }).sql, /GROUP BY/);
});

test('row filters use typed values, AND, and explicit null operators', () => {
  const result = compiler.compile({ metrics: ['revenue'], filters: [
    { field: 'orders.amount', operator: 'ne', value: 10 },
    { field: 'orders.refund_amount', operator: 'isNull' },
    { field: 'orders.status', operator: 'isNotNull' },
    { field: 'orders.country', operator: 'eq', value: "x\\'; SELECT 1;--" },
  ] });
  assert.match(result.sql, /WHERE "t0"\."AMOUNT" <> 10 AND "t0"\."REFUND_AMOUNT" IS NULL AND "t0"\."STATUS" IS NOT NULL AND/);
  assert.ok(result.sql.endsWith("'x\\\\''; SELECT 1;--'"));
});

test('query errors refuse unknown names, unsupported properties and ambiguous value modes', () => {
  const cases = [
    [{ metrics: ['unknown'] }, 'UNKNOWN_METRIC'],
    [{ metrics: ['revenue'], dimensions: ['country'] }, 'UNKNOWN_FIELD'],
    [{ metrics: ['revenue'], dimensions: ['revenue'] }, 'UNKNOWN_FIELD'],
    [{ metrics: ['revenue', 'REVENUE'] }, 'DUPLICATE_SELECTION'],
    [{ metrics: ['revenue'], dimensions: ['orders.country', 'ORDERS.COUNTRY'] }, 'DUPLICATE_SELECTION'],
    [{ metrics: [] }, 'INVALID_QUERY'],
    [{ metrics: ['revenue'], dimensions: null }, 'INVALID_SHAPE'],
    [{ metrics: ['revenue'], filters: null }, 'INVALID_SHAPE'],
    [{ metrics: ['revenue'], top: 10 }, 'UNSUPPORTED_FEATURE'],
    [{ metrics: ['revenue'], limit: 0 }, 'INVALID_QUERY'],
    [{ metrics: ['revenue'], valueMode: 'bound' }, 'UNSUPPORTED_VALUE_MODE'],
    [{ metrics: ['revenue'], filters: [{ field: 'revenue', operator: 'eq', value: 1 }] }, 'UNKNOWN_FIELD'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.country', operator: 'in', value: ['UK'] }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.country', operator: 'contains', value: 'UK' }] }, 'UNSUPPORTED_OPERATOR'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.country', operator: 'eq', value: null }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.country', operator: 'eq', value: 1 }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.amount', operator: 'eq', value: '10 OR 1=1' }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.amount', operator: 'eq', value: 1e21 }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.country', operator: 'isNull', value: null }] }, 'INVALID_FILTER_VALUE'],
  ];
  for (const [value, code] of cases) assert.throws(() => compiler.compile(value), { code });
});

test('catalog exposes declared names and immutable type metadata', () => {
  const catalog = compiler.catalog();
  assert.equal(catalog.datasets[0].fields.length, 4);
  assert.equal(catalog.datasets[0].dimensions[0].name, 'orders.country');
  assert.deepEqual(catalog.metrics, [{ name: 'revenue', datatype: 'Decimal' }]);
  assert.throws(() => { catalog.metrics[0].name = 'changed'; }, TypeError);
});
