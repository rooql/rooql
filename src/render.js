// Renders a resolved expression tree as SQL for one output dialect.
// Every operator is parenthesised, so the emitted SQL never depends on precedence rules.
import { FUNCTIONS } from './functions.js';
import { fail } from './errors.js';
import { boundedSql } from './limits.js';
import { stringLiteral, valueLiteral } from './literals.js';
import { inferType } from './types.js';
import { BIGQUERY_TYPES, bigqueryCall, bigqueryLike } from './bigquery.js';
import { outputIdentifier } from './identifiers.js';

const TYPED = { snowflake: { DATE: 'DATE', TIME: 'TIME', TIMESTAMP: 'TIMESTAMP_NTZ' }, duckdb: { DATE: 'DATE', TIME: 'TIME', TIMESTAMP: 'TIMESTAMP' }, bigquery: BIGQUERY_TYPES };

// alias: dataset key -> table alias such as "t0".
export function renderExpression(node, dialect, alias, cache = new Map()) {
  if (!cache.has(node)) cache.set(node, boundedSql(renderNode(node, dialect, child => renderExpression(child, dialect, alias, cache), alias)));
  return cache.get(node);
}

function renderNode(node, dialect, r, alias) {
  switch (node.type) {
    case 'column': return `${outputIdentifier(alias(node.dataset), dialect)}.${outputIdentifier(node.column, dialect)}`;
    case 'field': return r(node.expr);
    case 'lit':
      if (node.kind === 'null') return 'NULL';
      if (node.kind === 'boolean') return node.value ? 'TRUE' : 'FALSE';
      if (node.kind === 'string') return stringLiteral(node.value, dialect);
      return node.value;
    case 'typed': return dialect === 'bigquery' ? valueLiteral(node.value, inferType(node), dialect)
      : `${TYPED[dialect][node.kind]} ${stringLiteral(node.value, dialect)}`;
    case 'star': return '*';
    case 'unary': return node.op === 'NOT' ? `(NOT ${r(node.arg)})` : `(-${r(node.arg)})`;
    case 'binary': return dialect === 'bigquery' && node.op === '%' ? `MOD(${r(node.left)}, ${r(node.right)})` : `(${r(node.left)} ${node.op} ${r(node.right)})`;
    case 'isnull': return `(${r(node.arg)} IS ${node.negated ? 'NOT ' : ''}NULL)`;
    case 'distinctfrom': return `(${r(node.left)} IS ${node.negated ? 'NOT ' : ''}DISTINCT FROM ${r(node.right)})`;
    case 'in': return `(${r(node.arg)} ${node.negated ? 'NOT ' : ''}IN (${node.list.map(r).join(', ')}))`;
    case 'between': return `(${r(node.arg)} ${node.negated ? 'NOT ' : ''}BETWEEN ${r(node.low)} AND ${r(node.high)})`;
    case 'like': return dialect === 'bigquery'
      ? bigqueryLike(r(node.arg), r(node.pattern), node.negated, node.ilike)
      : `(${r(node.arg)} ${node.negated ? 'NOT ' : ''}${node.ilike ? 'ILIKE' : 'LIKE'} ${r(node.pattern)})`;
    case 'cast': {
      if (node.try && dialect === 'snowflake' && inferType(node.arg) !== 'String') {
        fail('UNSUPPORTED_EXPRESSION', 'Snowflake TRY_CAST needs a known string argument');
      }
      if (dialect === 'bigquery' && node.to.name === 'DECIMAL') fail('UNSUPPORTED_EXPRESSION', 'BigQuery CAST cannot enforce DECIMAL precision and scale');
      const type = node.to.name === 'DECIMAL' ? `DECIMAL(${node.to.precision}, ${node.to.scale})` : (TYPED[dialect][node.to.name] ?? node.to.name);
      return `${node.try ? dialect === 'bigquery' ? 'SAFE_CAST' : 'TRY_CAST' : 'CAST'}(${r(node.arg)} AS ${type})`;
    }
    case 'case': {
      const parts = ['CASE'];
      if (node.operand) parts.push(r(node.operand));
      for (const { when, then } of node.whens) parts.push(`WHEN ${r(when)} THEN ${r(then)}`);
      if (node.else) parts.push(`ELSE ${r(node.else)}`);
      parts.push('END');
      return parts.join(' ');
    }
    case 'call': {
      const spec = FUNCTIONS[node.name];
      const args = node.args.map(arg => (arg === node.args[spec.datePart] && spec.datePart !== undefined ? `'${node.part}'` : r(arg)));
      if (dialect === 'bigquery') {
        const rendered = bigqueryCall(node, args);
        if (rendered !== undefined) return rendered;
      }
      if (spec.render) return spec.render(args, dialect, node);
      return `${node.name}(${node.distinct ? 'DISTINCT ' : ''}${args.join(', ')})`;
    }
    default: throw new Error(`Unrenderable node ${node.type}`);
  }
}
