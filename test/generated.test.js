import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createRooql, loadOssieModel } from '../src/index.js';
const db = await (await DuckDBInstance.create(':memory:')).connect();
after(() => db.closeSync());
let seed = 73129;
const rnd = (n) => Math.floor(((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * n);
const regions = [
  { id: 1, name: 'North' },
  { id: 2, name: 'South' },
];
const customers = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  region_id: i % 4,
  segment: i % 3 === 0 ? null : i % 2 ? 'retail' : 'trade',
  credit: (i + 1) * 100,
}));
const products = Array.from({ length: 8 }, (_, i) => ({
  id: Math.floor(i / 2) + 1,
  variant: i % 2,
  category: i % 3 === 0 ? null : i % 2 ? 'tools' : 'paint',
  price: 3 + i,
}));
const orders = Array.from({ length: 300 }, (_, i) => ({
  id: i + 1,
  customer_id: rnd(16),
  product_id: rnd(6),
  variant: rnd(2),
  status: ['paid', 'returned', null][rnd(3)],
  amount: rnd(7) === 0 ? null : rnd(400) - 100,
  refund: rnd(4) === 0 ? null : rnd(20),
  quantity: rnd(6),
}));
const lit = (x) => (x === null ? 'NULL' : typeof x === 'string' ? `'${x.replaceAll("'", "''")}'` : String(x));
for (const [name, data, types] of [
  ['regions', regions, 'id INTEGER,name VARCHAR'],
  ['customers', customers, 'id INTEGER,region_id INTEGER,segment VARCHAR,credit INTEGER'],
  ['products', products, 'id INTEGER,variant INTEGER,category VARCHAR,price INTEGER'],
  [
    'orders',
    orders,
    'id INTEGER,customer_id INTEGER,product_id INTEGER,variant INTEGER,status VARCHAR,amount INTEGER,refund INTEGER,quantity INTEGER',
  ],
]) {
  await db.run(`CREATE TABLE ${name}(${types})`);
  await db.run(
    `INSERT INTO ${name} VALUES ${data.map((row) => `(${Object.values(row).map(lit).join(',')})`).join(',')}`,
  );
}
const doc = {
  version: '0.2.0.dev0',
  name: 'differential',
  datasets: [
    {
      name: 'orders',
      source: 'orders',
      primary_key: ['id'],
      fields: Object.keys(orders[0]).map((name) => ({
        name,
        expression: name,
        datatype: name === 'status' ? 'String' : 'Integer',
      })),
    },
    {
      name: 'customers',
      source: 'customers',
      primary_key: ['id'],
      fields: Object.keys(customers[0]).map((name) => ({
        name,
        expression: name,
        datatype: name === 'segment' ? 'String' : 'Integer',
      })),
    },
    {
      name: 'regions',
      source: 'regions',
      primary_key: ['id'],
      fields: Object.keys(regions[0]).map((name) => ({
        name,
        expression: name,
        datatype: name === 'name' ? 'String' : 'Integer',
      })),
    },
    {
      name: 'products',
      source: 'products',
      primary_key: ['id', 'variant'],
      fields: Object.keys(products[0]).map((name) => ({
        name,
        expression: name,
        datatype: name === 'category' ? 'String' : 'Integer',
      })),
    },
  ],
  relationships: [
    { name: 'o_c', from: 'orders', to: 'customers', from_columns: ['customer_id'], to_columns: ['id'] },
    { name: 'c_r', from: 'customers', to: 'regions', from_columns: ['region_id'], to_columns: ['id'] },
    {
      name: 'o_p',
      from: 'orders',
      to: 'products',
      from_columns: ['product_id', 'variant'],
      to_columns: ['id', 'variant'],
    },
  ],
  metrics: [
    { name: 'net', expression: 'SUM(orders.amount - COALESCE(orders.refund, 0))' },
    { name: 'count_orders', expression: 'COUNT(orders.id)' },
    { name: 'buyers', expression: 'COUNT(DISTINCT customers.id)' },
    { name: 'list_value', expression: 'SUM(orders.quantity * products.price)' },
    { name: 'max_credit', expression: 'MAX(customers.credit)' },
  ],
};
const compiler = createRooql({ model: await loadOssieModel(JSON.stringify(doc)), dialect: 'duckdb' });
const joined = orders.map((o) => {
  const c = customers.find((c) => c.id === o.customer_id);
  return {
    orders: o,
    customers: c,
    regions: regions.find((r) => r.id === c?.region_id),
    products: products.find((p) => p.id === o.product_id && p.variant === o.variant),
  };
});
const value = (row, path) => {
  const [d, f] = path.split('.');
  return row[d]?.[f] ?? null;
};
const sum = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);
const metrics = {
  net: (rs) => sum(rs.filter((r) => r.orders.amount !== null).map((r) => r.orders.amount - (r.orders.refund ?? 0))),
  count_orders: (rs) => rs.length,
  buyers: (rs) => new Set(rs.flatMap((r) => (r.customers ? [r.customers.id] : []))).size,
  list_value: (rs) => sum(rs.flatMap((r) => (r.products ? [r.orders.quantity * r.products.price] : []))),
  max_credit: (rs) => {
    const vs = rs.flatMap((r) => (r.customers ? [r.customers.credit] : []));
    return vs.length ? Math.max(...vs) : null;
  },
};
const dims = ['orders.status', 'customers.segment', 'regions.name', 'products.category'];
// The oracle computes joins and integer aggregates in JavaScript, independently of SQL.
test('200 seeded star queries match an independent JavaScript oracle', async () => {
  const failures = [];
  const queries = new Set();
  for (let i = 0; i < 200; i++) {
    const dimensions = dims.filter(() => rnd(3) === 0);
    const selected = ['net', ...['count_orders', 'buyers', 'list_value', 'max_credit'].filter(() => rnd(2))];
    const filters = [];
    if (rnd(2)) filters.push({ field: 'orders.id', operator: 'gte', value: rnd(305) });
    if (rnd(3) === 0) filters.push({ field: 'customers.segment', operator: 'eq', value: 'retail' });
    if (rnd(3) === 0) filters.push({ field: 'regions.name', operator: 'isNotNull' });
    const having = rnd(3) === 0 ? [{ metric: 'net', operator: 'gt', value: 100 }] : [];
    const q = { metrics: selected, dimensions, filters, having };
    queries.add(JSON.stringify(q));
    const data = joined.filter((row) =>
      filters.every((f) =>
        f.operator === 'isNotNull'
          ? value(row, f.field) !== null
          : f.operator === 'gte'
            ? value(row, f.field) >= f.value
            : value(row, f.field) === f.value,
      ),
    );
    const groups = new Map();
    if (!dimensions.length) groups.set('[]', []);
    for (const row of data) {
      const k = JSON.stringify(dimensions.map((d) => value(row, d)));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }
    const expected = [];
    for (const [k, rs] of groups) {
      const ms = selected.map((m) => metrics[m](rs));
      if (having.length && !(ms[0] > 100)) continue;
      expected.push([...JSON.parse(k), ...ms]);
    }
    const c = compiler.compile(q);
    const raw = (await db.runAndReadAll(c.sql)).getRowObjectsJson();
    const actual = raw.map((row) =>
      c.columns.map((col) => {
        const v = row[col.alias];
        return col.kind === 'metric' && v !== null ? Number(v) : v;
      }),
    );
    const norm = (rs) => JSON.stringify(rs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (norm(actual) !== norm(expected)) failures.push({ i, q, actual, expected, sql: c.sql });
  }
  assert.ok(queries.size > 190);
  assert.deepEqual(failures, []);
});
