import test from 'node:test';
import assert from 'node:assert/strict';
import { createRooql, loadOssieModel } from '../src/index.js';
import { outputIdentifier, physicalIdentifier } from '../src/identifiers.js';
import { stringLiteral, valueLiteral } from '../src/literals.js';
import { document, expressions } from './fixtures/bigquery-cases.js';

const load = doc => loadOssieModel(JSON.stringify(doc));
const compiler = async (doc = document()) => createRooql({ model: await load(doc), dialect: 'bigquery' });

test('BigQuery renders expressions using GoogleSQL functions, types and argument order', async () => {
  const c = await compiler();
  for (const [name, , expected] of expressions) {
    const result = c.compile({ metrics: [name] });
    assert.ok(result.sql.includes(expected), `${name}: ${result.sql}`);
    assert.equal(result.dialect, 'bigquery');
    assert.deepEqual(c.compile({ metrics: [name] }), result);
  }
});

test('BigQuery preserves table case, quotes joins and aliases, and keeps result metadata', async () => {
  const doc = document();
  doc.datasets[0].source = '`my-project.Analytics.Events`';
  doc.datasets.push({ name: 'labels', source: 'Analytics.Labels', fields: [
    { name: 'id', expression: 'id', datatype: 'Integer' }, { name: 'label', expression: 'label', datatype: 'String' },
  ] });
  doc.relationships = [{ name: 'e_l', from: 'events', to: 'labels', from_columns: ['n'], to_columns: ['id'] }];
  const query = { metrics: ['remainder'], dimensions: ['labels.label'],
    filters: [{ field: 'events.s', operator: 'eq', value: "O'Reilly" }],
    having: [{ metric: 'remainder', operator: 'gt', value: 0 }],
    orderBy: [{ field: 'remainder', direction: 'desc' }], limit: 5 };
  const model = await load(doc);
  const result = createRooql({ model, dialect: 'bigquery' }).compile(query);
  assert.equal(result.sql, `SELECT
  \`t1\`.\`LABEL\` AS \`d0\`,
  SUM(MOD(\`t0\`.\`N\`, 2)) AS \`m0\`
FROM \`my-project.Analytics.Events\` AS \`t0\`
LEFT JOIN \`Analytics.Labels\` AS \`t1\` ON \`t0\`.\`N\` = \`t1\`.\`ID\`
WHERE \`t0\`.\`S\` = 'O\\'Reilly'
GROUP BY \`t1\`.\`LABEL\`
HAVING SUM(MOD(\`t0\`.\`N\`, 2)) > 0
ORDER BY \`m0\` DESC NULLS FIRST
LIMIT 5`);
  const duck = createRooql({ model, dialect: 'duckdb' }).compile(query);
  assert.deepEqual(result.columns, duck.columns);
  assert.equal(result.modelHash, duck.modelHash);
});

test('BigQuery escaping cannot turn strings or quoted identifiers into SQL', () => {
  assert.equal(stringLiteral("a'\\\n\0", 'bigquery'), "'a\\'\\\\\\u000a\\u0000'");
  assert.equal(outputIdentifier(physicalIdentifier('"a`b\\c"', 1), 'bigquery'), '`a\\`b\\\\c`');
  assert.equal(stringLiteral("x'; SELECT 1; --", 'bigquery'), "'x\\'; SELECT 1; --'");
});

test('BigQuery filters preserve decimal precision and distinguish civil time from instants', async () => {
  assert.equal(valueLiteral('9007199254740993.123456789', 'Decimal', 'bigquery'), "BIGNUMERIC '9007199254740993.123456789'");
  assert.equal(valueLiteral('2026-01-01T12:00:00', 'DateTime', 'bigquery'), "DATETIME '2026-01-01 12:00:00'");
  assert.equal(valueLiteral('2026-01-01', 'DateTime', 'bigquery'), "DATETIME '2026-01-01 00:00:00'");
  assert.equal(valueLiteral('12:00', 'Time', 'bigquery'), "TIME '12:00:00'");
  assert.equal(valueLiteral('2026-01-01T12:00:00+01:00', 'DateTimeTz', 'bigquery'), "CAST('2026-01-01T12:00:00+01:00' AS TIMESTAMP)");
  assert.equal(valueLiteral('2026-01-01T12:00+0100', 'DateTimeTz', 'bigquery'), "CAST('2026-01-01T12:00:00+01:00' AS TIMESTAMP)");
  assert.throws(() => valueLiteral('12:00:00.1234567', 'Time', 'bigquery'), { code: 'INVALID_FILTER_VALUE' });
  assert.throws(() => valueLiteral('0000-01-01', 'Date', 'bigquery'), { code: 'INVALID_FILTER_VALUE' });
  const c = await compiler();
  const result = c.compile({ metrics: ['hours', 'days'], dimensions: [{ field: 'events.d', grain: 'week' }] });
  assert.match(result.sql, /DATE_TRUNC\(`t0`\.`D`, WEEK\(MONDAY\)\)/);
  assert.deepEqual(result.columns.map(c => c.datatype), ['Date', 'DateTime', 'Date']);
  const filtered = c.compile({ metrics: ['days'], filters: [{ field: 'events.s', operator: 'notLike', value: 'a%' }] });
  assert.match(filtered.sql, /CASE WHEN `t0`\.`S` IS NULL OR 'a%' IS NULL THEN NULL ELSE CAST\(`t0`\.`S` AS STRING\) NOT LIKE/);
});

test('source normalization preserves double-quoted names containing backticks', async () => {
  const doc = document();
  doc.datasets[0].source = '"a`b`"';
  const model = await load(doc);
  assert.equal(model.datasets[0].source, '"a`b`"');
  assert.match(createRooql({ model, dialect: 'bigquery' }).compile({ metrics: ['days'] }).sql, /FROM `a\\`b\\``/);
});

test('BigQuery timezone-aware date arithmetic uses an explicit UTC civil conversion', async () => {
  const doc = document();
  doc.metrics = [
    { name: 'm', expression: 'MIN(DATEADD(month, 1, events.tz))' },
    { name: 'w', expression: "MIN(DATE_TRUNC('week', events.tz))" },
  ];
  const sql = (await compiler(doc)).compile({ metrics: ['m', 'w'] }).sql;
  assert.match(sql, /TIMESTAMP\(DATETIME_ADD\(CAST\(`t0`\.`TZ` AS DATETIME\), INTERVAL 1 MONTH\)\)/);
  assert.match(sql, /TIMESTAMP_TRUNC\(`t0`\.`TZ`, WEEK\(MONDAY\)\)/);
});

test('BigQuery refuses unsupported semantics rather than silently approximating them', async () => {
  for (const expression of ['MEDIAN(events.n)', 'SUM(CAST(events.n AS DECIMAL(18, 2)))',
    "MIN(SPLIT_PART(events.s, events.s, 1))", "MIN(DATEADD(day, 1, TIME '12:00:00'))", 'MIN(YEAR(events.s))']) {
    const doc = document();
    doc.metrics = [{ name: 'm', expression }];
    const c = await compiler(doc);
    assert.throws(() => c.compile({ metrics: ['m'] }), { code: 'UNSUPPORTED_EXPRESSION' });
  }
});
