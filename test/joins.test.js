import test from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createRooql, loadOssieModel } from '../src/index.js';

const fields = list => list.map(([name, datatype]) => ({ name, expression: name, datatype }));
const rel = (name, from, to, from_columns, to_columns) => ({ name, from, to, from_columns, to_columns });
const document = {
  version: '0.2.0.dev0',
  name: 'star',
  datasets: [
    { name: 'orders', source: 'orders', primary_key: ['order_id'], fields: fields([['order_id', 'Integer'], ['customer_id', 'Integer'], ['product_id', 'Integer'], ['variant', 'String'], ['status', 'String'], ['amount', 'Decimal'], ['quantity', 'Integer']]) },
    { name: 'customers', source: 'customers', primary_key: ['id'], fields: fields([['id', 'Integer'], ['region_id', 'Integer'], ['segment', 'String'], ['credit_limit', 'Decimal']]) },
    { name: 'regions', source: 'regions', primary_key: ['id'], fields: fields([['id', 'Integer'], ['name', 'String']]) },
    { name: 'products', source: 'products', primary_key: ['product_id', 'variant'], fields: fields([['product_id', 'Integer'], ['variant', 'String'], ['category', 'String'], ['price', 'Decimal']]) },
    { name: 'customer_profiles', source: 'customer_profiles', primary_key: ['customer_id'], fields: fields([['customer_id', 'Integer'], ['score', 'Integer']]) },
    { name: 'returns', source: 'returns', primary_key: ['return_id'], fields: fields([['return_id', 'Integer'], ['customer_id', 'Integer'], ['amount', 'Decimal']]) },
  ],
  relationships: [
    rel('orders_to_customers', 'orders', 'customers', ['customer_id'], ['id']),
    rel('customers_to_regions', 'customers', 'regions', ['region_id'], ['id']),
    rel('orders_to_products', 'orders', 'products', ['product_id', 'variant'], ['product_id', 'variant']),
    rel('profiles_to_customers', 'customer_profiles', 'customers', ['customer_id'], ['id']),
    rel('returns_to_customers', 'returns', 'customers', ['customer_id'], ['id']),
  ],
  metrics: [
    { name: 'revenue', expression: 'SUM(orders.amount)' },
    { name: 'order_count', expression: 'COUNT(orders.order_id)' },
    { name: 'buying_customers', expression: 'COUNT(DISTINCT customers.id)' },
    { name: 'list_value', expression: 'SUM(orders.quantity * products.price)' },
    { name: 'revenue_per_customer', expression: 'revenue / NULLIF(buying_customers, 0)' },
    { name: 'customer_count', expression: 'COUNT(customers.id)' },
    { name: 'total_score', expression: 'SUM(customer_profiles.score)' },
    { name: 'credit_total', expression: 'SUM(customers.credit_limit)' },
    { name: 'highest_credit', expression: 'MAX(customers.credit_limit)' },
    { name: 'returned', expression: 'SUM(returns.amount)' },
    { name: 'orders_everywhere', expression: 'COUNT(*)' },
  ],
};

const setup = [
  `CREATE TABLE regions AS SELECT * FROM (VALUES (1, 'North'), (2, 'South')) t(id, name)`,
  // Customer 3 has no region; customer 4 has no orders.
  `CREATE TABLE customers AS SELECT * FROM (VALUES (1, 1, 'retail', 500.00), (2, 1, 'trade', 900.00), (3, NULL, 'retail', 100.00), (4, 2, 'trade', 300.00)) t(id, region_id, segment, credit_limit)`,
  `CREATE TABLE products AS SELECT * FROM (VALUES (10, 'a', 'tools', 5.00), (10, 'b', 'tools', 7.00), (20, 'a', 'paint', 3.50)) t(product_id, variant, category, price)`,
  `CREATE TABLE customer_profiles AS SELECT * FROM (VALUES (1, 70), (2, 40), (3, 90), (4, 10)) t(customer_id, score)`,
  // Order 106 belongs to customer 999, who does not exist.
  `CREATE TABLE orders AS SELECT * FROM (VALUES
    (101, 1, 10, 'a', 'completed', 50.00, 2), (102, 1, 10, 'b', 'completed', 70.00, 1), (103, 2, 20, 'a', 'returned', 35.00, 4),
    (104, 2, 10, 'a', 'completed', 20.00, 3), (105, 3, 20, 'a', 'completed', 12.00, 1), (106, 999, 10, 'b', 'completed', 99.00, 5)
  ) t(order_id, customer_id, product_id, variant, status, amount, quantity)`,
  `CREATE TABLE returns AS SELECT * FROM (VALUES (1, 2, 35.00), (2, 4, 8.00)) t(return_id, customer_id, amount)`,
];

const db = await (await DuckDBInstance.create(':memory:')).connect();
for (const statement of setup) await db.run(statement);
const model = await loadOssieModel(JSON.stringify(document));
const duck = createRooql({ model, dialect: 'duckdb' });
const rows = async sql => (await db.runAndReadAll(sql)).getRowObjectsJson();
const named = async compiled => (await rows(compiled.sql)).map(row => Object.fromEntries(compiled.columns.map(c => [c.name, row[c.alias]])));
const sorted = list => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const cases = [
  ['two hops out, keeping orders whose customer is missing (NULL bucket)', { metrics: ['revenue', 'order_count'], dimensions: ['regions.name'] },
    `SELECT r.name AS "regions.name", SUM(o.amount) AS revenue, COUNT(o.order_id) AS order_count
     FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN regions r ON c.region_id = r.id GROUP BY 1`],
  ['COUNT(DISTINCT) over a coarser table is safe', { metrics: ['buying_customers', 'revenue_per_customer'], dimensions: ['orders.status'] },
    `SELECT o.status AS "orders.status", COUNT(DISTINCT c.id) AS buying_customers, SUM(o.amount) / NULLIF(COUNT(DISTINCT c.id), 0) AS revenue_per_customer
     FROM orders o LEFT JOIN customers c ON o.customer_id = c.id GROUP BY 1`],
  ['composite-key join with row-level enrichment inside SUM', { metrics: ['list_value'], dimensions: ['products.category', 'customers.segment'] },
    `SELECT p.category AS "products.category", c.segment AS "customers.segment", SUM(o.quantity * p.price) AS list_value
     FROM orders o LEFT JOIN products p ON o.product_id = p.product_id AND o.variant = p.variant LEFT JOIN customers c ON o.customer_id = c.id GROUP BY 1, 2`],
  ['filters on joined tables', { metrics: ['revenue'], dimensions: ['products.category'], filters: [{ field: 'customers.segment', operator: 'eq', value: 'retail' }, { field: 'regions.name', operator: 'isNotNull' }] },
    `SELECT p.category AS "products.category", SUM(o.amount) AS revenue FROM orders o
     LEFT JOIN products p ON o.product_id = p.product_id AND o.variant = p.variant LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN regions r ON c.region_id = r.id
     WHERE c.segment = 'retail' AND r.name IS NOT NULL GROUP BY 1`],
  ['a dimension table on its own counts every row, with or without orders', { metrics: ['customer_count', 'credit_total'], dimensions: ['regions.name'] },
    `SELECT r.name AS "regions.name", COUNT(c.id) AS customer_count, SUM(c.credit_limit) AS credit_total
     FROM customers c LEFT JOIN regions r ON c.region_id = r.id GROUP BY 1`],
  ['one-to-one enrichment keeps the metric owner as anchor', { metrics: ['total_score'], dimensions: ['customers.segment'] },
    `SELECT c.segment AS "customers.segment", SUM(cp.score) AS total_score
     FROM customer_profiles cp LEFT JOIN customers c ON c.id = cp.customer_id GROUP BY 1`],
  ['MAX over a coarser table is safe', { metrics: ['revenue', 'highest_credit'], dimensions: ['orders.status'] },
    `SELECT o.status AS "orders.status", SUM(o.amount) AS revenue, MAX(c.credit_limit) AS highest_credit
     FROM orders o LEFT JOIN customers c ON o.customer_id = c.id GROUP BY 1`],
  ['COUNT(*) counts the fact rows another metric anchors on', { metrics: ['revenue', 'orders_everywhere'], dimensions: ['regions.name'] },
    `SELECT r.name AS "regions.name", SUM(o.amount) AS revenue, COUNT(*) AS orders_everywhere FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN regions r ON c.region_id = r.id GROUP BY 1`],
  ['one-to-one links work in either direction', { metrics: ['revenue'], dimensions: ['customer_profiles.score'] },
    `SELECT cp.score AS "customer_profiles.score", SUM(o.amount) AS revenue FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN customer_profiles cp ON c.id = cp.customer_id GROUP BY 1`],
];

for (const [name, query, reference] of cases) {
  test(`joins: ${name}`, async () => {
    assert.deepEqual(sorted(await named(duck.compile(query))), sorted(await rows(reference)));
  });
}

test('the orphan order lands in a NULL region instead of disappearing', async () => {
  const result = await named(duck.compile({ metrics: ['revenue'], dimensions: ['regions.name'] }));
  const total = result.reduce((sum, row) => sum + Number(row.revenue), 0);
  assert.equal(total, 286);
  assert.ok(result.some(row => row['regions.name'] === null));
});

test('unsafe joins fail with a typed error instead of a wrong number', async () => {
  const bad = [
    [{ metrics: ['credit_total'], dimensions: ['orders.status'] }, 'FANOUT_UNSAFE'],
    [{ metrics: ['revenue', 'returned'], dimensions: ['regions.name'] }, 'MULTI_FACT_UNSUPPORTED'],
    [{ metrics: ['revenue'], dimensions: ['returns.amount'] }, 'NO_PATH'],
    [{ metrics: ['orders_everywhere'], dimensions: ['regions.name'] }, 'AMBIGUOUS_ANCHOR'],
  ];
  for (const [query, code] of bad) assert.throws(() => duck.compile(query), { code });

  const twoRoutes = structuredClone(document);
  twoRoutes.datasets[0].fields.push({ name: 'ship_region_id', expression: 'ship_region_id', datatype: 'Integer' });
  twoRoutes.relationships.push(rel('orders_to_ship_region', 'orders', 'regions', ['ship_region_id'], ['id']));
  const ambiguous = createRooql({ model: await loadOssieModel(JSON.stringify(twoRoutes)), dialect: 'duckdb' });
  assert.throws(() => ambiguous.compile({ metrics: ['revenue'], dimensions: ['regions.name'] }), { code: 'AMBIGUOUS_PATH' });
  assert.throws(() => ambiguous.compile({ metrics: ['order_count'], dimensions: ['regions.name'] }), { code: 'AMBIGUOUS_PATH' });
});

test('joined SQL is deterministic and readable', () => {
  const { sql } = createRooql({ model, dialect: 'snowflake' }).compile({ metrics: ['revenue'], dimensions: ['regions.name'] });
  assert.equal(sql, `SELECT
  "t2"."NAME" AS "d0",
  SUM("t0"."AMOUNT") AS "m0"
FROM "ORDERS" AS "t0"
LEFT JOIN "CUSTOMERS" AS "t1" ON "t0"."CUSTOMER_ID" = "t1"."ID"
LEFT JOIN "REGIONS" AS "t2" ON "t1"."REGION_ID" = "t2"."ID"
GROUP BY "t2"."NAME"`);
});

test('relationship mistakes in the model fail at load time', async () => {
  const broken = [
    [d => { d.relationships[0].to = 'nowhere'; }, 'UNKNOWN_DATASET'],
    [d => { d.relationships[0].to_columns = ['id', 'extra']; }, 'INVALID_SHAPE'],
    [d => { d.relationships[0].to = 'orders'; }, 'UNSUPPORTED_FEATURE'],
    [d => { d.relationships[0].name = 'orders'; }, 'NAME_COLLISION'],
  ];
  for (const [change, code] of broken) {
    const copy = structuredClone(document);
    change(copy);
    await assert.rejects(loadOssieModel(JSON.stringify(copy)), { code });
  }
});
