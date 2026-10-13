// The Ossie functions RooQL compiles, and how each one is written in each output dialect.
// A function missing from this table is rejected rather than passed through, because a
// name that means different things in Snowflake and DuckDB would give silently wrong numbers.
import { fail } from './errors.js';

// kind: 'aggregate' | 'scalar'. args: [min, max]. distinct: DISTINCT allowed.
// duplicateSafe: the result is unchanged if input rows are repeated (used by the join planner).
// type: result datatype rule (see types.js). render: (args, dialect, node) => SQL, default NAME(args).
const call = name => args => `${name}(${args.join(', ')})`;
const entries = (names, args, type, options = {}) => Object.fromEntries(names.split(' ').map(name => [name, { kind: 'scalar', args: [args, args], type, ...options }]));
const weekStart = (date, dialect) => dialect === 'duckdb' ? `DATE_TRUNC('week', ${date})` : `DATEADD(day, 1 - DAYOFWEEKISO(${date}), DATE_TRUNC('day', ${date}))`;
const caseWhen = ([condition, yes, no]) => `CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`;
const DATE_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second'];
const DUCKDB_INTERVAL = { year: 'to_years', quarter: 'to_months', month: 'to_months', week: 'to_weeks', day: 'to_days', hour: 'to_hours', minute: 'to_minutes', second: 'to_seconds' };

export const FUNCTIONS = {
  // Aggregates
  SUM: { kind: 'aggregate', args: [1, 1], distinct: true, numeric: true, type: 'same-numeric' },
  COUNT: { kind: 'aggregate', args: [1, 1], distinct: true, star: true, type: 'Integer' },
  AVG: { kind: 'aggregate', args: [1, 1], numeric: true, type: 'average' },
  ...entries('MIN MAX', 1, 'same', { kind: 'aggregate', duplicateSafe: true }),
  MEDIAN: { kind: 'aggregate', args: [1, 1], numeric: true, type: 'average' },
  ...entries('STDDEV STDDEV_SAMP STDDEV_POP VARIANCE VAR_SAMP VAR_POP', 1, 'Float', { kind: 'aggregate', numeric: true }),
  APPROX_COUNT_DISTINCT: { kind: 'aggregate', args: [1, 1], duplicateSafe: true, type: 'Integer' },

  // Conditional
  COALESCE: { kind: 'scalar', args: [2, 32], type: 'widest' },
  ...entries('IFNULL NVL', 2, 'widest', { render: call('COALESCE') }),
  NVL2: { kind: 'scalar', args: [3, 3], type: 'widest-tail', render: ([x, a, b]) => `CASE WHEN ${x} IS NOT NULL THEN ${a} ELSE ${b} END` },
  NULLIF: { kind: 'scalar', args: [2, 2], type: 'first' },
  ...entries('IF IFF', 3, 'widest-tail', { render: caseWhen }),
  ZEROIFNULL: { kind: 'scalar', args: [1, 1], type: 'first', render: ([x]) => `COALESCE(${x}, 0)` },
  NULLIFZERO: { kind: 'scalar', args: [1, 1], type: 'first', render: ([x]) => `NULLIF(${x}, 0)` },

  // Maths
  ...entries('ABS FLOOR CEIL', 1, 'first'),
  ROUND: { kind: 'scalar', args: [1, 2], type: 'first' },
  CEILING: { kind: 'scalar', args: [1, 1], type: 'first', render: call('CEIL') },
  SIGN: { kind: 'scalar', args: [1, 1], type: 'Integer' },
  MOD: { kind: 'scalar', args: [2, 2], type: 'first' },
  POWER: { kind: 'scalar', args: [2, 2], type: 'Float' },
  ...entries('SQRT EXP LN', 1, 'Float'),

  // Strings
  CONCAT: { kind: 'scalar', args: [1, 32], type: 'String', render: args => args.length === 1 ? `CAST(${args[0]} AS VARCHAR)` : `(${args.join(' || ')})` },
  ...entries('LOWER UPPER TRIM LTRIM RTRIM', 1, 'String'),
  LENGTH: { kind: 'scalar', args: [1, 1], type: 'Integer' },
  ...entries('LEFT RIGHT', 2, 'String'),
  SUBSTRING: { kind: 'scalar', args: [2, 3], type: 'String' },
  SUBSTR: { kind: 'scalar', args: [2, 3], type: 'String', render: call('SUBSTRING') },
  REPLACE: { kind: 'scalar', args: [3, 3], type: 'String' },
  SPLIT_PART: { kind: 'scalar', args: [3, 3], type: 'String' },
  CONTAINS: { kind: 'scalar', args: [2, 2], type: 'Boolean' },
  STARTSWITH: { kind: 'scalar', args: [2, 2], type: 'Boolean', render: (args, dialect) => call(dialect === 'duckdb' ? 'starts_with' : 'STARTSWITH')(args) },
  ENDSWITH: { kind: 'scalar', args: [2, 2], type: 'Boolean', render: (args, dialect) => call(dialect === 'duckdb' ? 'ends_with' : 'ENDSWITH')(args) },

  // Dates and times
  CURRENT_DATE: { kind: 'scalar', args: [0, 0], type: 'Date', render: () => 'CURRENT_DATE' },
  CURRENT_TIMESTAMP: { kind: 'scalar', args: [0, 0], type: 'DateTimeTz', render: () => 'CURRENT_TIMESTAMP' },
  ...entries('YEAR QUARTER MONTH DAY DAYOFYEAR HOUR MINUTE SECOND', 1, 'Integer'),
  WEEK: { kind: 'scalar', args: [1, 1], type: 'Integer', render: (args, dialect) => call(dialect === 'duckdb' ? 'WEEK' : 'WEEKISO')(args) },
  DATE_TRUNC: { kind: 'scalar', args: [2, 2], datePart: 0, type: 'second', render: ([part, date], dialect, node) => node.part === 'week' ? weekStart(date, dialect) : `DATE_TRUNC(${part}, ${date})` },
  DATEADD: {
    kind: 'scalar', args: [3, 3], datePart: 0, type: 'dateadd',
    render: ([part, amount, date], dialect, node) => {
      const unit = node.part;
      if (dialect !== 'duckdb') return `DATEADD(${unit}, ${amount}, ${date})`;
      const shift = `${DUCKDB_INTERVAL[unit]}(${unit === 'quarter' ? `3 * (${amount})` : amount})`;
      // Only day-or-larger shifts keep a DATE result; sub-day shifts must retain time.
      return node.dateTyped ? `CAST((${date} + ${shift}) AS DATE)` : `(${date} + ${shift})`;
    },
  },
  DATEDIFF: {
    kind: 'scalar', args: [3, 3], datePart: 0, type: 'Integer',
    render: ([, start, end], dialect, node) => {
      const diff = (part, a, b) => dialect === 'duckdb' ? `date_diff('${part}', ${a}, ${b})` : `DATEDIFF(${part}, ${a}, ${b})`;
      return node.part === 'week' ? `CAST((${diff('day', weekStart(start, dialect), weekStart(end, dialect))} / 7) AS BIGINT)` : diff(node.part, start, end);
    },
  },
};

export const GRAINS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'];

export function functionSpec(node, path) {
  const spec = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
  if (!spec) fail('UNSUPPORTED_FUNCTION', `${node.name} is not a supported function`, path);
  const [min, max] = spec.args;
  if (node.args.length < min || node.args.length > max) {
    fail('UNSUPPORTED_EXPRESSION', `${node.name} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? '' : 's'}`, path);
  }
  if (node.distinct && !spec.distinct) fail('UNSUPPORTED_EXPRESSION', `${node.name} does not support DISTINCT`, path);
  if (node.args.some(arg => arg.type === 'star') && !(spec.star && node.args.length === 1 && !node.distinct)) {
    fail('UNSUPPORTED_EXPRESSION', `* is only allowed as COUNT(*)`, path);
  }
  if (spec.datePart !== undefined) {
    const partNode = node.args[spec.datePart];
    const raw = partNode.type === 'lit' && partNode.kind === 'string' ? partNode.value : null;
    const part = raw?.toLowerCase();
    if (!part || !DATE_PARTS.includes(part) || (node.name === 'DATE_TRUNC' && part === 'second')) {
      fail('UNSUPPORTED_EXPRESSION', `${node.name} needs a date part: ${DATE_PARTS.filter(p => node.name !== 'DATE_TRUNC' || p !== 'second').join(', ')}`, path);
    }
    node.part = part;
  }
  return spec;
}
