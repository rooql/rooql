// GoogleSQL spellings stay here so the common compiler and join planner remain small.
import { fail } from './errors.js';
import { inferType } from './types.js';

export const BIGQUERY_TYPES = { VARCHAR: 'STRING', BIGINT: 'INT64', DOUBLE: 'FLOAT64', BOOLEAN: 'BOOL', DATE: 'DATE', TIME: 'TIME', TIMESTAMP: 'DATETIME' };
const CLOCK = ['hour', 'minute', 'second'];
const temporal = node => {
  const type = inferType(node);
  if (!['Date', 'DateTime', 'DateTimeTz', 'Time'].includes(type)) fail('UNSUPPORTED_EXPRESSION', 'BigQuery date functions need a known temporal datatype');
  return type;
};
const part = node => node.part === 'week' ? 'WEEK(MONDAY)' : node.part.toUpperCase();
const unsupported = name => fail('UNSUPPORTED_EXPRESSION', `${name} has no equivalent in the BigQuery expression subset`);

export function bigqueryLike(subject, pattern, negated, insensitive = false) {
  const text = sql => insensitive ? `LOWER(CAST(${sql} AS STRING))` : `CAST(${sql} AS STRING)`;
  // GoogleSQL's scalar LIKE errors on NULL; preserve SQL three-valued logic explicitly.
  return `(CASE WHEN ${subject} IS NULL OR ${pattern} IS NULL THEN NULL ELSE ${text(subject)} ${negated ? 'NOT ' : ''}LIKE ${text(pattern)} END)`;
}

export function bigqueryCall(node, args) {
  const [a, b, c] = args;
  switch (node.name) {
    case 'MEDIAN': return unsupported('Exact MEDIAN');
    case 'CONCAT': return `CONCAT(${args.map(arg => `CAST(${arg} AS STRING)`).join(', ')})`;
    case 'CONTAINS': return `(STRPOS(${a}, ${b}) > 0)`;
    case 'STARTSWITH': return `STARTS_WITH(${a}, ${b})`;
    case 'ENDSWITH': return `ENDS_WITH(${a}, ${b})`;
    case 'SPLIT_PART': {
      const delimiter = node.args[1];
      if (delimiter.type !== 'lit' || delimiter.kind !== 'string') return unsupported('SPLIT_PART with a nonliteral delimiter');
      const list = delimiter.value === '' ? `[${a}]` : `SPLIT(${a}, ${b})`;
      return `CASE WHEN ${a} IS NULL OR ${c} IS NULL THEN NULL ELSE COALESCE(IF(${c} < 0, ARRAY_REVERSE(${list}), ${list})[SAFE_ORDINAL(IF(${c} = 0, 1, ABS(${c})))], '') END`;
    }
    case 'YEAR': case 'QUARTER': case 'MONTH': case 'WEEK': case 'DAY': case 'DAYOFYEAR': case 'HOUR': case 'MINUTE': case 'SECOND': {
      const type = temporal(node.args[0]);
      const clock = CLOCK.includes(node.name.toLowerCase());
      if (type === 'Time' && !clock) return unsupported('Calendar extraction from TIME');
      return `EXTRACT(${node.name === 'WEEK' ? 'ISOWEEK' : node.name} FROM ${type === 'Date' && clock ? `CAST(${a} AS DATETIME)` : a})`;
    }
    case 'DATE_TRUNC': {
      const type = temporal(node.args[1]);
      if (type === 'Time' && !CLOCK.includes(node.part)) return unsupported('Calendar truncation of TIME');
      if (type === 'Date' && CLOCK.includes(node.part)) return `CAST(DATETIME_TRUNC(CAST(${b} AS DATETIME), ${part(node)}) AS DATE)`;
      const fn = { Date: 'DATE', DateTime: 'DATETIME', DateTimeTz: 'TIMESTAMP', Time: 'TIME' }[type];
      return `${fn}_TRUNC(${b}, ${part(node)})`;
    }
    case 'DATEADD': {
      const type = temporal(node.args[2]);
      const clock = CLOCK.includes(node.part);
      if (type === 'Time' && !clock) return unsupported('Calendar addition to TIME');
      if (type === 'DateTimeTz') return `TIMESTAMP(DATETIME_ADD(CAST(${c} AS DATETIME), INTERVAL ${b} ${node.part.toUpperCase()}))`;
      const fn = type === 'Time' ? 'TIME' : type === 'Date' && !clock ? 'DATE' : 'DATETIME';
      const date = type === 'Date' && clock ? `CAST(${c} AS DATETIME)` : c;
      return `${fn}_ADD(${date}, INTERVAL ${b} ${node.part.toUpperCase()})`;
    }
    case 'DATEDIFF': {
      const start = temporal(node.args[1]);
      const end = temporal(node.args[2]);
      if (start === 'Time' || end === 'Time') {
        if (start !== end || !CLOCK.includes(node.part)) return unsupported('Mixed or calendar TIME differences');
        return `TIME_DIFF(${c}, ${b}, ${part(node)})`;
      }
      // DATETIME_DIFF counts civil boundaries, including UTC calendar units for instants.
      return `DATETIME_DIFF(CAST(${c} AS DATETIME), CAST(${b} AS DATETIME), ${part(node)})`;
    }
    default: return undefined;
  }
}
