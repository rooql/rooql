import { fail } from './errors.js';
import { children } from './parse.js';

const shapes = new WeakMap();

// Count repeated references at every use, while measuring each shared subtree only once.
export function checkComplexity(node, path, depth = 0) {
  if (depth > 128) fail('EXPRESSION_TOO_COMPLEX', 'Expanded expression depth exceeds 128', path);
  let shape = shapes.get(node);
  if (!shape) {
    const parts = children(node).map(child => checkComplexity(child, path, depth + 1));
    shape = { size: 1 + parts.reduce((sum, p) => sum + p.size, 0), depth: 1 + Math.max(0, ...parts.map(p => p.depth)) };
    shapes.set(node, shape);
  }
  if (shape.size > 8192 || depth + shape.depth > 128) fail('EXPRESSION_TOO_COMPLEX', 'Expanded expression exceeds 8192 nodes or 128 levels', path);
  return shape;
}

export function boundedSql(sql) {
  if (sql.length > 262144) fail('QUERY_TOO_COMPLEX', 'Generated SQL exceeds 262144 characters');
  return sql;
}
