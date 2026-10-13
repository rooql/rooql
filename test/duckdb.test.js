import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRooql, loadOssieModel } from '../src/index.js';
import { duckdbLiteral } from '../src/literals.js';
import { exampleQueries, loadExampleCompiler, openExampleDatabase, runCompiled } from '../examples/duckdb/run.mjs';

// Independent oracle: aggregate the CSV in plain JavaScript, in integer cents.
async function csvOrders() {
  const text = await readFile(new URL('../examples/duckdb/orders.csv', import.meta.url), 'utf8');
  const [header, ...lines] = text.trim().split('\n');
  const keys = header.split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [keys[index], value])));
}
const cents = value => Math.round(Number(value) * 100);
const euros = value => (value / 100).toFixed(2);

test('duckdb literals use standard SQL escaping', () => {
  assert.equal(duckdbLiteral("O'Brien", 'String', 'v'), "'O''Brien'");
  assert.equal(duckdbLiteral('C:\\path', 'String', 'v'), "'C:\\path'");
  assert.equal(duckdbLiteral(42, 'Integer', 'v'), '42');
  assert.throws(() => duckdbLiteral('a\u0000b', 'String', 'v'), { code: 'INVALID_FILTER_VALUE' });
  assert.equal(duckdbLiteral(1.5, 'Decimal', 'v'), '1.5');
  assert.throws(() => duckdbLiteral(1.5, 'Integer', 'v'), { code: 'INVALID_FILTER_VALUE' });
});

test('the same model compiles for snowflake and duckdb', async () => {
  const model = await loadOssieModel(await readFile(new URL('../examples/duckdb/model.json', import.meta.url), 'utf8'));
  const query = { metrics: ['net_revenue'], filters: [{ field: 'orders.country', operator: 'eq', value: 'C:\\x' }] };
  const duck = createRooql({ model, dialect: 'duckdb' }).compile(query);
  const snow = createRooql({ model, dialect: 'snowflake' }).compile(query);
  assert.equal(duck.dialect, 'duckdb');
  assert.match(duck.sql, /= 'C:\\x'$/m);
  assert.match(snow.sql, /= 'C:\\\\x'$/m);
});

test('example queries return the same numbers as the raw CSV', async () => {
  const compiler = await loadExampleCompiler();
  const connection = await openExampleDatabase();
  const orders = await csvOrders();

  const [byCountry, byChannel, totals] = exampleQueries.map(({ query }) => compiler.compile(query));

  const countryRows = await runCompiled(connection, byCountry);
  for (const row of countryRows) {
    const rows = orders.filter(order => order.country === row['orders.country']);
    assert.equal(row.net_revenue, euros(rows.reduce((sum, order) => sum + cents(order.amount) - cents(order.refund_amount), 0)));
    assert.equal(Number(row.order_count), rows.length);
  }
  assert.equal(countryRows.length, new Set(orders.map(order => order.country)).size);

  const channelRows = await runCompiled(connection, byChannel);
  for (const row of channelRows) {
    const rows = orders.filter(order => order.channel === row['orders.channel'] && order.status !== 'cancelled');
    assert.equal(row.gross_revenue, euros(rows.reduce((sum, order) => sum + cents(order.amount), 0)));
    assert.equal(row.refunds, euros(rows.reduce((sum, order) => sum + cents(order.refund_amount), 0)));
  }

  const [total] = await runCompiled(connection, totals);
  assert.equal(total.gross_revenue, euros(orders.reduce((sum, order) => sum + cents(order.amount), 0)));
  assert.equal(Number(total.order_count), orders.length);
});

test('a filter value containing quotes cannot break out of the literal', async () => {
  const compiler = await loadExampleCompiler();
  const connection = await openExampleDatabase();
  const compiled = compiler.compile({
    metrics: ['order_count'],
    filters: [{ field: 'orders.country', operator: 'eq', value: "x' OR '1'='1" }],
  });
  const [row] = await runCompiled(connection, compiled);
  assert.equal(Number(row.order_count), 0);
});
