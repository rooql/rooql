import test from 'node:test';
import assert from 'node:assert/strict';
import { createRooql, loadOssieModel } from '../src/index.js';

const load = expression => loadOssieModel(JSON.stringify({
  version: '0.2.0.dev0', name: 'expressions',
  datasets: [{ name: 'orders', source: 'orders', fields: [
    { name: 'amount', expression: 'amount', datatype: 'Decimal' },
    { name: 'refund', expression: 'refund', datatype: 'Decimal' },
    { name: 'status', expression: 'status', datatype: 'String' },
  ] }],
  metrics: [{ name: 'm', expression }],
}));
const sql = async expression => createRooql({ model: await load(expression), dialect: 'duckdb' }).compile({ metrics: ['m'] }).sql;

test('the active parser keeps subtraction grouping and supports count variants', async () => {
  assert.match(await sql('sum(orders.amount - (orders.refund + orders.amount))'), /SUM\(\("t0"\."AMOUNT" - \("t0"\."REFUND" \+ "t0"\."AMOUNT"\)\)\)/);
  assert.match(await sql('COUNT(*)'), /COUNT\(\*\)/);
  assert.match(await sql('COUNT(DISTINCT orders.status)'), /COUNT\(DISTINCT "t0"\."STATUS"\)/);
});

test('the active parser rejects SQL passthrough, comments, subqueries and malformed expressions', async () => {
  for (const expression of ['SUM(orders.amount); SELECT 1', 'SUM(orders.amount) -- trailing',
    'SUM(orders.amount/*x*/)', 'SUM((SELECT orders.amount))', 'SUM()', 'SUM(orders.amount']) {
    await assert.rejects(load(expression), { code: 'UNSUPPORTED_EXPRESSION' }, expression);
  }
});

test('numeric aggregates reject known string inputs through the public loader', async () => {
  for (const aggregate of ['SUM', 'AVG', 'MEDIAN', 'STDDEV', 'VAR_POP']) {
    await assert.rejects(load(`${aggregate}(orders.status)`), { code: 'INVALID_METRIC_TYPE' });
  }
  await assert.rejects(load('SUM(other.amount)'), { code: 'UNKNOWN_DATASET' });
  await assert.rejects(load('SUM(missing_metric)'), { code: 'UNKNOWN_METRIC' });
});

test('the active parser bounds nesting and tokens', async () => {
  await assert.rejects(load(`SUM(${'('.repeat(70)}orders.amount${')'.repeat(70)})`), { code: 'UNSUPPORTED_EXPRESSION' });
  await assert.rejects(load(`SUM(${Array(1000).fill('orders.amount').join('+')})`), { code: 'UNSUPPORTED_EXPRESSION' });
});
