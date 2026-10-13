// Real-world compatibility: every model in the Apache Ossie repository either loads, or is
// refused with a typed RooqlError. Loaded models compile each metric or refuse it with a typed
// error, and never crash. The counts pin today's coverage so a regression is visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createRooql, loadOssieModel, RooqlError } from '../src/index.js';

const dir = new URL('./fixtures/ossie-corpus/', import.meta.url);
const files = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();

// Refusals the spec allows or RooQL deliberately leaves for later.
const ALLOWED_LOAD_REFUSALS = new Set(['UNSUPPORTED_DIALECT', 'UNSUPPORTED_FEATURE', 'UNSUPPORTED_FUNCTION', 'UNSUPPORTED_EXPRESSION']);
const ALLOWED_QUERY_REFUSALS = new Set(['FANOUT_UNSAFE', 'AMBIGUOUS_ANCHOR', 'MULTI_FACT_UNSUPPORTED', 'AMBIGUOUS_PATH', 'NO_PATH']);

test('every Ossie corpus model loads or is refused with a typed error', async () => {
  let loaded = 0;
  let compiled = 0;
  for (const file of files) {
    const text = await readFile(new URL(file, dir), 'utf8');
    let model;
    try {
      model = await loadOssieModel(text);
      loaded++;
    } catch (error) {
      assert.ok(error instanceof RooqlError, `${file}: ${error.message}`);
      assert.ok(ALLOWED_LOAD_REFUSALS.has(error.code), `${file}: unexpected ${error.code} ${error.message}`);
      continue;
    }
    for (const dialect of ['snowflake', 'duckdb', 'bigquery']) {
      const compiler = createRooql({ model, dialect });
      for (const { name } of compiler.catalog().metrics) {
        try {
          assert.match(compiler.compile({ metrics: [name] }).sql, /^SELECT\n/);
          compiled++;
        } catch (error) {
          assert.ok(error instanceof RooqlError, `${file} ${name}: ${error.message}`);
          assert.ok(ALLOWED_QUERY_REFUSALS.has(error.code) || (dialect === 'bigquery' && error.code === 'UNSUPPORTED_EXPRESSION'), `${file} ${name}: unexpected ${error.code}`);
        }
      }
    }
  }
  assert.equal(files.length, 23);
  assert.ok(loaded >= 10, `expected at least 10 corpus models to load, got ${loaded}`);
  assert.ok(compiled >= 54, `expected at least 54 metric compilations, got ${compiled}`);
});
