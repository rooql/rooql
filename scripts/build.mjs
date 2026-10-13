// Builds the browser bundles into dist/ and enforces the size budget.
//   dist/rooql.js       ES module
//   dist/rooql.iife.js  plain script that defines a global `rooql`
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const BUDGET = 20 * 1024; // gzipped bytes per bundle

await mkdir('dist', { recursive: true });
const shared = { entryPoints: ['src/index.js'], bundle: true, minify: true, platform: 'browser', target: 'es2022' };
await build({ ...shared, format: 'esm', outfile: 'dist/rooql.js' });
await build({ ...shared, format: 'iife', globalName: 'rooql', outfile: 'dist/rooql.iife.js' });

const sizes = {};
for (const name of ['rooql.js', 'rooql.iife.js']) {
  const bytes = await readFile(`dist/${name}`);
  sizes[name] = { raw: bytes.length, gzip: gzipSync(bytes).length };
  if (sizes[name].gzip > BUDGET) throw new Error(`${name} is ${sizes[name].gzip} bytes gzipped, over the ${BUDGET} byte budget`);
}
await writeFile('dist/sizes.json', JSON.stringify(sizes, null, 2) + '\n');
console.log(JSON.stringify(sizes, null, 2));
