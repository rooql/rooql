import test from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createRooql, loadOssieModel } from '../src/index.js';

const f = (name, expression, datatype, extra = {}) => ({ name, expression, ...(datatype ? { datatype } : {}), ...extra });
const m = (name, expression) => ({ name, expression });
const modelText = JSON.stringify({
  version: '0.2.0.dev0',
  name: 'shop',
  datasets: [{
    name: 'orders',
    source: 'orders',
    primary_key: ['order_id'],
    fields: [
      f('order_id', 'order_id', 'Integer'),
      f('order_date', 'order_date', 'Date'),
      f('customer_id', 'customer_id', 'Integer'),
      f('country', 'country', 'String'),
      f('status', 'status', 'String'),
      f('amount', 'amount', 'Decimal'),
      f('refund_amount', 'refund_amount', 'Decimal'),
      f('sku', 'sku', 'String'),
      // Computed fields
      f('net_amount', 'amount - COALESCE(refund_amount, 0)', 'Decimal'),
      f('size_band', "CASE WHEN amount >= 300 THEN 'large' WHEN amount >= 100 THEN 'medium' ELSE 'small' END", 'String'),
      f('label', "LOWER(country) || '-' || status"),
      f('is_completed', "status = 'completed'", 'Boolean'),
      f('order_year', 'YEAR(order_date)', 'Integer', { dimension: { is_time: true } }),
      f('due_date', 'DATEADD(day, 30, order_date)', 'Date'),
      f('sku_family', "IFF(STARTSWITH(sku, 'SKU-1'), 'one', NVL(sku, 'none'))"),
    ],
  }],
  metrics: [
    m('revenue', 'SUM(orders.amount)'),
    m('order_count', 'COUNT(*)'),
    m('customers', 'COUNT(DISTINCT orders.customer_id)'),
    m('average_order', 'AVG(orders.amount)'),
    m('largest_order', 'MAX(orders.amount)'),
    m('net_revenue', 'SUM(orders.net_amount)'),
    m('completed_revenue', "SUM(CASE WHEN orders.status = 'completed' THEN orders.amount ELSE 0 END)"),
    m('average_order_value', 'revenue / NULLIF(order_count, 0)'),
    m('refund_rate', 'SUM(orders.refund_amount) / NULLIF(SUM(orders.amount), 0) * 100'),
    m('skus_known', 'COUNT(orders.sku)'),
  ],
});

const setup = `CREATE TABLE orders AS
SELECT i AS order_id,
  CAST(DATE '2026-01-01' + CAST(i % 270 AS INTEGER) AS DATE) AS order_date,
  i % 50 AS customer_id,
  ['Italy', 'France', 'Spain', 'Germany'][1 + i % 4] AS country,
  CASE WHEN i % 10 = 0 THEN 'cancelled' WHEN i % 13 = 0 THEN 'returned' ELSE 'completed' END AS status,
  CAST((i * 37) % 500 + 10 AS DECIMAL(12, 2)) + 0.25 AS amount,
  CASE WHEN i % 7 = 0 THEN CAST(5 AS DECIMAL(12, 2)) WHEN i % 11 = 0 THEN NULL ELSE CAST(0 AS DECIMAL(12, 2)) END AS refund_amount,
  CASE WHEN i % 17 = 0 THEN NULL ELSE 'SKU-' || (i % 9) END AS sku
FROM range(1, 1001) t(i)`;

const db = await (await DuckDBInstance.create(':memory:')).connect();
await db.run(setup);
const model = await loadOssieModel(modelText);
const duck = createRooql({ model, dialect: 'duckdb' });
const snow = createRooql({ model, dialect: 'snowflake' });
const rows = async sql => (await db.runAndReadAll(sql)).getRowObjectsJson();
const named = async compiled => (await rows(compiled.sql)).map(row => Object.fromEntries(compiled.columns.map(c => [c.name + (c.grain ? `:${c.grain}` : ''), row[c.alias]])));
const sorted = list => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// Each case: a RooQL query and hand-written DuckDB SQL that must return the same rows.
const cases = [
  ['computed fields and conditional metrics', {
    metrics: ['net_revenue', 'completed_revenue', 'order_count'], dimensions: ['orders.size_band'],
  }, `SELECT CASE WHEN amount >= 300 THEN 'large' WHEN amount >= 100 THEN 'medium' ELSE 'small' END AS "orders.size_band",
      SUM(amount - COALESCE(refund_amount, 0)) AS net_revenue,
      SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) AS completed_revenue, COUNT(*) AS order_count
     FROM orders GROUP BY 1`],
  ['distinct counts, averages, max and metrics built from metrics', {
    metrics: ['customers', 'average_order', 'largest_order', 'average_order_value', 'refund_rate'], dimensions: ['orders.country'],
  }, `SELECT country AS "orders.country", COUNT(DISTINCT customer_id) AS customers, AVG(amount) AS average_order, MAX(amount) AS largest_order,
      SUM(amount) / NULLIF(COUNT(*), 0) AS average_order_value, SUM(refund_amount) / NULLIF(SUM(amount), 0) * 100 AS refund_rate
     FROM orders GROUP BY 1`],
  ['monthly time grain with a date range filter', {
    metrics: ['revenue'], dimensions: [{ field: 'orders.order_date', grain: 'month' }],
    filters: [{ field: 'orders.order_date', operator: 'between', values: ['2026-02-01', '2026-05-31'] }],
  }, `SELECT DATE_TRUNC('month', order_date) AS "orders.order_date:month", SUM(amount) AS revenue
     FROM orders WHERE order_date BETWEEN DATE '2026-02-01' AND DATE '2026-05-31' GROUP BY 1`],
  ['in, like, comparison and null filters', {
    metrics: ['order_count', 'skus_known'], dimensions: ['orders.status'],
    filters: [
      { field: 'orders.country', operator: 'in', values: ['Italy', 'Spain'] },
      { field: 'orders.sku', operator: 'notLike', value: 'SKU-1%' },
      { field: 'orders.amount', operator: 'gte', value: 50.25 },
      { field: 'orders.refund_amount', operator: 'isNotNull' },
    ],
  }, `SELECT status AS "orders.status", COUNT(*) AS order_count, COUNT(sku) AS skus_known FROM orders
     WHERE country IN ('Italy', 'Spain') AND sku NOT LIKE 'SKU-1%' AND amount >= 50.25 AND refund_amount IS NOT NULL GROUP BY 1`],
  ['having, order by and limit', {
    metrics: ['revenue'], dimensions: ['orders.customer_id'],
    having: [{ metric: 'revenue', operator: 'gt', value: 5000 }],
    orderBy: [{ field: 'revenue', direction: 'desc' }, { field: 'orders.customer_id' }], limit: 5,
  }, `SELECT customer_id AS "orders.customer_id", SUM(amount) AS revenue FROM orders GROUP BY 1
     HAVING SUM(amount) > 5000 ORDER BY revenue DESC, customer_id LIMIT 5`],
  ['boolean, string and date functions as dimensions', {
    metrics: ['order_count'], dimensions: ['orders.is_completed', 'orders.order_year', 'orders.sku_family', 'orders.label'],
    filters: [{ field: 'orders.due_date', operator: 'lt', value: '2026-03-01' }],
  }, `SELECT status = 'completed' AS "orders.is_completed", YEAR(order_date) AS "orders.order_year",
      CASE WHEN starts_with(sku, 'SKU-1') THEN 'one' ELSE COALESCE(sku, 'none') END AS "orders.sku_family",
      LOWER(country) || '-' || status AS "orders.label", COUNT(*) AS order_count
     FROM orders WHERE order_date + INTERVAL 30 DAY < DATE '2026-03-01' GROUP BY ALL`],
];

for (const [name, query, reference] of cases) {
  test(`DuckDB: ${name}`, async () => {
    const compiled = duck.compile(query);
    const actual = await named(compiled);
    const expected = await rows(reference);
    assert.ok(expected.length > 0, 'the reference query should return rows');
    if (query.orderBy) assert.deepEqual(actual, expected);
    else assert.deepEqual(sorted(actual), sorted(expected));
    // The Snowflake build of the same query compiles too, deterministically.
    assert.equal(snow.compile(query).sql, snow.compile(query).sql);
  });
}

test('each dialect spells functions its own way', () => {
  const query = { metrics: ['order_count'], dimensions: ['orders.sku_family', 'orders.due_date', { field: 'orders.order_date', grain: 'week' }] };
  const snowSql = snow.compile(query).sql;
  const duckSql = duck.compile(query).sql;
  assert.match(snowSql, /CASE WHEN STARTSWITH\("t0"\."SKU", 'SKU-1'\) THEN 'one' ELSE COALESCE\("t0"\."SKU", 'none'\) END/);
  assert.match(duckSql, /starts_with\("t0"\."SKU", 'SKU-1'\)/);
  assert.match(snowSql, /DATEADD\(day, 30, "t0"\."ORDER_DATE"\)/);
  assert.match(duckSql, /CAST\(\("t0"\."ORDER_DATE" \+ to_days\(30\)\) AS DATE\)/);
  assert.match(snowSql, /DAYOFWEEKISO\("t0"\."ORDER_DATE"\)/);
  assert.doesNotMatch(snowSql, /DATE_TRUNC\('week'/);
});

test('query columns describe grains and inferred types', () => {
  const { columns } = duck.compile({ metrics: ['average_order_value', 'customers'], dimensions: [{ field: 'orders.order_date', grain: 'quarter' }] });
  assert.deepEqual(columns, [
    { alias: 'd0', kind: 'dimension', name: 'orders.order_date', datatype: 'Date', grain: 'quarter' },
    { alias: 'm0', kind: 'metric', name: 'average_order_value', datatype: 'Decimal' },
    { alias: 'm1', kind: 'metric', name: 'customers', datatype: 'Integer' },
  ]);
});

test('query mistakes fail with a clear code', () => {
  const bad = [
    [{ metrics: ['revenue'], dimensions: [{ field: 'orders.country', grain: 'month' }] }, 'GRAIN_NOT_APPLICABLE'],
    [{ metrics: ['revenue'], dimensions: [{ field: 'orders.order_date', grain: 'fortnight' }] }, 'INVALID_QUERY'],
    [{ metrics: ['revenue'], orderBy: [{ field: 'orders.country' }] }, 'ORDER_BY_NOT_SELECTED'],
    [{ metrics: ['revenue'], having: [{ metric: 'revenue', operator: 'like', value: '1%' }] }, 'UNSUPPORTED_OPERATOR'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.order_date', operator: 'eq', value: '01/02/2026' }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], filters: [{ field: 'orders.country', operator: 'between', values: ['A'] }] }, 'INVALID_FILTER_VALUE'],
    [{ metrics: ['revenue'], measures: ['revenue'] }, 'INVALID_QUERY'],
  ];
  for (const [query, code] of bad) assert.throws(() => duck.compile(query), { code });
});
