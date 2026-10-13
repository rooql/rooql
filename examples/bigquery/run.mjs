// Emit a self-contained GoogleSQL query using the same 16 synthetic orders as DuckDB.
// It reads no warehouse tables and creates no persistent resources.
import { readFile } from 'node:fs/promises';
import { createRooql, loadOssieModel } from '../../src/index.js';
import { valueLiteral } from '../../src/literals.js';

const modelText = await readFile(new URL('../duckdb/model.json', import.meta.url), 'utf8');
const model = await loadOssieModel(modelText);
const compiler = createRooql({ model, dialect: 'bigquery' });
const query = process.argv[2] ? JSON.parse(process.argv[2]) : {
  metrics: ['net_revenue', 'order_count'], dimensions: ['orders.country'],
  filters: [{ field: 'orders.status', operator: 'eq', value: 'completed' }],
  orderBy: [{ field: 'net_revenue', direction: 'desc' }],
};
// This checked-in fixture contains no quoted cells or embedded commas.
const [header, ...rows] = (await readFile(new URL('../duckdb/orders.csv', import.meta.url), 'utf8')).trim().split('\n');
const columns = header.split(',');
const types = new Map(model.datasets[0].fields.map(field => [field.name.split('.')[1], field.datatype]));
const selects = rows.map(row => `  SELECT ${row.split(',').map((cell, i) => {
  const type = types.get(columns[i]);
  const value = type === 'Integer' ? Number(cell) : cell;
  return `${valueLiteral(value, type, 'bigquery')} AS \`${columns[i]}\``;
}).join(', ')}`);
console.log(`WITH orders AS (\n${selects.join('\n  UNION ALL\n')}\n)\n${compiler.compile(query).sql};`);
