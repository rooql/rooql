import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRooql, loadOssieModel, OSSIE_REVISION } from '../src/index.js';

const text = await readFile(new URL('./fixtures/revenue.model.json', import.meta.url), 'utf8');
const document = () => JSON.parse(text);
const modified = change => {
  const model = document();
  change(model);
  return JSON.stringify(model);
};

test('snapshot hashes exact UTF-8 bytes and recursively freezes validated contents', async () => {
  const model = await loadOssieModel(text);
  assert.equal(model.modelHash, createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.equal(model.specRevision, OSSIE_REVISION);
  assert.equal(model.datasets[0].source, '"AGENT_DEMO"."PUBLIC"."ROOQL_ORDERS"');
  assert.ok(Object.isFrozen(model.metrics[0].expr.args[0]));
  assert.throws(() => { model.datasets[0].fields[0].column = 'injected'; }, TypeError);
  assert.throws(() => { model.metrics.push({}); }, TypeError);
  const spaced = await loadOssieModel(`${text}\n`);
  assert.notEqual(model.modelHash, spaced.modelHash);
  assert.equal(createRooql({ model, dialect: 'snowflake' }).compile({ metrics: ['revenue'] }).sql,
    createRooql({ model: spaced, dialect: 'snowflake' }).compile({ metrics: ['revenue'] }).sql);
});

test('Unicode model metadata hashes as exact UTF-8 and does not enter SQL', async () => {
  const source = modified(model => { model.name = 'café 😀'; model.description = 'hello'; });
  const model = await loadOssieModel(source);
  assert.equal(model.modelHash, createHash('sha256').update(source, 'utf8').digest('hex'));
  assert.equal(model.name, 'café 😀');
});

test('the validator refuses malformed models and features outside the supported subset', async () => {
  const cases = [
    [model => { model.version = '0.1'; }, 'UNSUPPORTED_VERSION'],
    [model => { model.datasets.push(model.datasets[0]); }, 'DUPLICATE_NAME'],
    [model => { model.relationships = [{}]; }, 'INVALID_NAME'],
    [model => { model.metrics[0].name = 'orders'; }, 'NAME_COLLISION'],
    [model => { model.custom_extensions = [{ vendor_name: 'COMMON', data: 1 }]; }, 'INVALID_SHAPE'],
    [model => { model.datasets[0].source = 'SELECT * FROM orders'; }, 'UNSUPPORTED_FEATURE'],
    [model => { model.datasets[0].source = 'orders; DROP TABLE x'; }, 'INVALID_IDENTIFIER'],
    [model => { model.datasets[0].fields[0].expression.dialects[0].expression = 'other.country'; }, 'UNKNOWN_DATASET'],
    [model => { model.datasets[0].fields[0].expression.dialects[0].expression = 'SUM(amount)'; }, 'AGGREGATE_IN_FIELD'],
    [model => { model.datasets[0].fields[0].expression.dialects[0].expression = 'MYSTERY(country)'; }, 'UNSUPPORTED_FUNCTION'],
    [model => { model.datasets[0].fields[0].expression.dialects[0].dialect = 'SNOWFLAKE'; }, 'UNSUPPORTED_DIALECT'],
    [model => { model.datasets[0].fields[0].datatype = 'Text'; }, 'UNSUPPORTED_DATATYPE'],
    [model => { model.datasets[0].fields[0].dimension = { is_time: 'yes' }; }, 'INVALID_SHAPE'],
    [model => { model.datasets[0].fields.push({ ...model.datasets[0].fields[0], name: 'COUNTRY' }); }, 'DUPLICATE_NAME'],
    [model => { model.metrics.push({ ...model.metrics[0], name: 'REVENUE' }); }, 'DUPLICATE_NAME'],
    [model => { model.metrics[0].expression.dialects[0].expression = 'SUM(other.amount)'; }, 'UNKNOWN_DATASET'],
    [model => { model.metrics[0].expression.dialects[0].expression = 'orders.amount'; }, 'UNAGGREGATED_FIELD'],
    [model => { model.metrics[0].expression.dialects[0].expression = 'SUM(SUM(orders.amount))'; }, 'NESTED_AGGREGATE'],
    [model => { model.metrics[0].expression.dialects[0].expression = 'revenue + 1'; }, 'CYCLIC_REFERENCE'],
    [model => { model.metrics[0].expression.dialects[0].expression = '1 + 2'; }, 'METRIC_WITHOUT_AGGREGATE'],
    [model => { model.metrics[0].expression.dialects[0].expression = 'SUM(orders.amount) OVER ()'; }, 'UNSUPPORTED_EXPRESSION'],
    [model => { model.sql = 'SELECT 1'; }, 'UNSUPPORTED_FEATURE'],
    [model => { model.metrics = null; }, 'INVALID_SHAPE'],
    [model => { model.datasets[0].fields[0].dimension = { label: 'country' }; }, 'UNSUPPORTED_FEATURE'],
    [model => { model.ai_context = { synonyms: [1] }; }, 'INVALID_SHAPE'],
  ];
  for (const [change, code] of cases) await assert.rejects(loadOssieModel(modified(change)), { code });
  await assert.rejects(loadOssieModel('{'), { code: 'INVALID_JSON' });
  await assert.rejects(loadOssieModel(document()), { code: 'INVALID_MODEL' });
  await assert.rejects(loadOssieModel('null'), { code: 'INVALID_SHAPE' });
});

test('real-world model shapes load: ANSI_SQL, several dialects, no datatypes, vendor extensions', async () => {
  const model = await loadOssieModel(modified(value => {
    const country = value.datasets[0].fields[0];
    country.expression = { dialects: [{ dialect: 'SNOWFLAKE', expression: 'country::varchar' }, { dialect: 'ANSI_SQL', expression: 'country' }] };
    delete country.datatype;
    value.datasets[0].fields[1].expression = 'status';
    value.custom_extensions = [{ vendor_name: 'DBT', data: '{"project": "x"}' }];
    value.datasets[0].fields[2].custom_extensions = [{ vendor_name: 'SNOWFLAKE', data: '{}' }];
    value.datasets[0].fields.push({ name: 'placed_on', expression: 'placed_on', datatype: 'Date' });
    value.datasets[0].fields.push({ name: 'is_big', expression: 'amount > 100', datatype: 'Boolean' });
    value.metrics[0].expression = { dialects: [{ expression: 'SUM(orders.amount)' }] };
    delete value.metrics[0].datatype;
  }));
  const country = model.datasets[0].fields[0];
  assert.equal(country.dialect, 'ANSI_SQL');
  assert.equal(country.datatype, undefined);
  assert.equal(model.datasets[0].fields.find(f => f.name === 'orders.placed_on').isTime, true);
  assert.equal(model.metrics[0].datatype, 'Decimal');
  const sql = createRooql({ model, dialect: 'snowflake' }).compile({ metrics: ['revenue'], dimensions: ['orders.country'] }).sql;
  assert.match(sql, /"t0"\."COUNTRY" AS "d0"/);
});

test('harmless pinned-schema metadata is accepted while names stay unambiguous', async () => {
  const model = await loadOssieModel(modified(value => {
    value.description = 'test';
    value.ai_context = { instructions: 'test', synonyms: ['sales'], extra_context: 'metadata only' };
    value.relationships = [];
    value.custom_extensions = [];
    value.datasets[0].primary_key = ['country'];
    value.datasets[0].unique_keys = [['country', 'status']];
    value.datasets[0].fields[0].dimension = { is_time: false };
    value.datasets[0].fields[0].label = 'Country';
  }));
  const compiler = createRooql({ model, dialect: 'snowflake' });
  assert.equal(compiler.catalog().metrics[0].name, 'revenue');
});

test('a forged or cloned snapshot cannot bypass validation', async () => {
  const model = await loadOssieModel(text);
  assert.throws(() => createRooql({ model: JSON.parse(JSON.stringify(model)), dialect: 'snowflake' }), { code: 'INVALID_MODEL' });
  assert.throws(() => createRooql({ model, dialect: 'postgres' }), { code: 'UNSUPPORTED_DIALECT' });
});
