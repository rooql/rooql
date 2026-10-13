// Compile semantic queries with rooql and run them in an in-memory DuckDB.
//
//   npm run example:duckdb                       # run the built-in example queries
//   npm run example:duckdb -- '<query json>'     # run your own query
//
// e.g. npm run example:duckdb -- '{"metrics":["net_revenue"],"dimensions":["orders.channel"]}'

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { createRooql, loadOssieModel } from '../../src/index.js';

const here = new URL('./', import.meta.url);

export const exampleQueries = [
  { title: 'Net revenue by country', query: { metrics: ['net_revenue', 'order_count'], dimensions: ['orders.country'] } },
  {
    title: 'Gross vs net revenue by channel, completed and returned orders only',
    query: {
      metrics: ['gross_revenue', 'refunds', 'net_revenue'],
      dimensions: ['orders.channel'],
      filters: [{ field: 'orders.status', operator: 'ne', value: 'cancelled' }],
    },
  },
  { title: 'Totals', query: { metrics: ['gross_revenue', 'refunds', 'net_revenue', 'order_count'] } },
];

// Load the CSV into a table called "orders" (the model's dataset source).
export async function openExampleDatabase() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const csvPath = fileURLToPath(new URL('orders.csv', here)).replaceAll("'", "''");
  await connection.run(`
    CREATE TABLE orders (
      order_id INTEGER PRIMARY KEY,
      country VARCHAR,
      channel VARCHAR,
      status VARCHAR,
      amount DECIMAL(12, 2),
      refund_amount DECIMAL(12, 2)
    )`);
  await connection.run(`COPY orders FROM '${csvPath}' (HEADER)`);
  return connection;
}

export async function loadExampleCompiler() {
  const model = await loadOssieModel(await readFile(new URL('model.json', here), 'utf8'));
  return createRooql({ model, dialect: 'duckdb' });
}

// Run compiled SQL and rename the generated aliases (d0, m0, ...) to semantic names.
export async function runCompiled(connection, compiled) {
  const reader = await connection.runAndReadAll(compiled.sql);
  return reader.getRowObjectsJson().map(row =>
    Object.fromEntries(compiled.columns.map(column => [column.name, row[column.alias]])));
}

async function main() {
  const compiler = await loadExampleCompiler();
  const connection = await openExampleDatabase();
  const custom = process.argv[2];
  const queries = custom ? [{ title: 'Your query', query: JSON.parse(custom) }] : exampleQueries;

  if (!custom) {
    const { metrics, datasets } = compiler.catalog();
    console.log('Metrics:', metrics.map(metric => metric.name).join(', '));
    console.log('Dimensions:', datasets[0].dimensions.map(field => field.name).join(', '));
  }

  for (const { title, query } of queries) {
    const compiled = compiler.compile(query);
    console.log(`\n=== ${title} ===`);
    console.log('Query:', JSON.stringify(query));
    console.log(`\n${compiled.sql}\n`);
    console.table(await runCompiled(connection, compiled));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.code ? `${error.code}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
