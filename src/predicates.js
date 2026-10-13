import { fail } from './errors.js';
import { valueLiteral } from './literals.js';
import { array } from './validation.js';
import { bigqueryLike } from './bigquery.js';

const COMPARISONS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
export const FILTER_OPERATORS = [...Object.keys(COMPARISONS), 'in', 'notIn', 'between', 'notBetween', 'like', 'notLike', 'isNull', 'isNotNull'];
export const HAVING_OPERATORS = [...Object.keys(COMPARISONS), 'between', 'isNull', 'isNotNull'];

export function predicate(subject, datatype, { operator, value, values }, path, operators, dialect) {
  if (['like', 'notLike'].includes(operator)) {
    if (datatype && datatype !== 'String') fail('UNSUPPORTED_OPERATOR', 'LIKE needs a string field', path);
    datatype = 'String';
  }
  if (!operators.includes(operator)) fail('UNSUPPORTED_OPERATOR', `Supported operators are ${operators.join(', ')}`, `${path}.operator`);
  const literal = (v, p) => {
    if (v === null || v === undefined) fail('INVALID_FILTER_VALUE', 'Use isNull or isNotNull to test for null', p);
    return valueLiteral(v, datatype, dialect, p);
  };
  if (operator === 'isNull' || operator === 'isNotNull') {
    if (value !== undefined || values !== undefined) fail('INVALID_FILTER_VALUE', 'Null checks do not take a value', path);
    return `${subject} IS ${operator === 'isNotNull' ? 'NOT ' : ''}NULL`;
  }
  if (['in', 'notIn', 'between', 'notBetween'].includes(operator)) {
    if (value !== undefined) fail('INVALID_FILTER_VALUE', `${operator} takes values, a list`, path);
    array(values, `${path}.values`);
    if (operator.endsWith('etween')) {
      if (values.length !== 2) fail('INVALID_FILTER_VALUE', 'between takes exactly two values: [low, high]', `${path}.values`);
      return `${subject} ${operator === 'notBetween' ? 'NOT ' : ''}BETWEEN ${literal(values[0], `${path}.values[0]`)} AND ${literal(values[1], `${path}.values[1]`)}`;
    }
    if (!values.length || values.length > 1000) fail('INVALID_FILTER_VALUE', `${operator} takes 1 to 1000 values`, `${path}.values`);
    return `${subject} ${operator === 'notIn' ? 'NOT ' : ''}IN (${values.map((v, j) => literal(v, `${path}.values[${j}]`)).join(', ')})`;
  }
  if (values !== undefined) fail('INVALID_FILTER_VALUE', `${operator} takes a single value`, path);
  if (operator === 'like' || operator === 'notLike') {
    if (typeof value !== 'string') fail('INVALID_FILTER_VALUE', 'like takes a string pattern', `${path}.value`);
    if (dialect === 'bigquery') return bigqueryLike(subject, literal(value, `${path}.value`), operator === 'notLike');
    return `${subject} ${operator === 'notLike' ? 'NOT ' : ''}LIKE ${literal(value, `${path}.value`)}`;
  }
  return `${subject} ${COMPARISONS[operator]} ${literal(value, `${path}.value`)}`;
}
