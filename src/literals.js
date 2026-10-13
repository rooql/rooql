import { fail } from './errors.js';

// Snowflake treats backslash as an escape inside single quotes; DuckDB follows standard SQL,
// where the only escape is a doubled quote.
export function stringLiteral(value, dialect, path) {
  if (!value.isWellFormed()) fail('INVALID_FILTER_VALUE', 'String contains an unpaired surrogate', path);
  if (dialect === 'duckdb') {
    if (value.includes('\u0000')) fail('INVALID_FILTER_VALUE', 'String contains a NUL character', path);
    return `'${value.replaceAll("'", "''")}'`;
  }
  const escaped = value.replaceAll('\\', '\\\\').replaceAll("'", dialect === 'bigquery' ? "\\'" : "''")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `'${escaped}'`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const DATETIME_TZ = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;
const DECIMAL_TEXT = /^-?\d{1,38}(\.\d{1,38})?$/;

function validTemporal(value, ...formats) {
  if (typeof value !== 'string' || !formats.some(format => format.test(value))) return false;
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (date) {
    const [, year, month, day] = date.map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return false;
  }
  const time = /(?:^|[ T])(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  const offset = /[+-](\d{2}):?(\d{2})$/.exec(value);
  return (!time || (+time[1] < 24 && +time[2] < 60 && +(time[3] ?? 0) < 60))
    && (!offset || (+offset[1] < 24 && +offset[2] < 60));
}

function numberText(value, integer, path) {
  if (typeof value === 'string' && !integer && DECIMAL_TEXT.test(value)) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_FILTER_VALUE', 'Expected a number', path);
  if (integer && !Number.isSafeInteger(value)) fail('INVALID_FILTER_VALUE', 'Integer filters require a safe integer', path);
  const text = String(value);
  if (!DECIMAL_TEXT.test(text)) fail('INVALID_FILTER_VALUE', 'Pass very large or very small decimals as a string, like "0.000001"', path);
  return text;
}

// A typed filter value as an inline SQL literal. Unknown datatypes take the JavaScript type.
export function valueLiteral(value, datatype, dialect, path) {
  const type = datatype ?? (typeof value === 'string' ? 'String' : typeof value === 'number' ? 'Decimal' : typeof value === 'boolean' ? 'Boolean' : undefined);
  if (dialect === 'bigquery' && ['Date', 'Time', 'DateTime', 'DateTimeTz'].includes(type) && typeof value === 'string') {
    if (/\.\d{7}/.test(value) || value.startsWith('0000-')) fail('INVALID_FILTER_VALUE', 'BigQuery temporal values need years 1–9999 and at most six fractional digits', path);
    if (type === 'DateTime' && DATE.test(value)) value += ' 00:00:00';
    value = value.replace(/((?:^|[ T])\d{2}:\d{2})(?=$|Z|[+-])/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  }
  switch (type) {
    case 'String':
      if (typeof value !== 'string') fail('INVALID_FILTER_VALUE', 'Expected a string value', path);
      return stringLiteral(value, dialect, path);
    case 'Integer': return numberText(value, true, path);
    case 'Decimal': case 'Float': {
      const text = numberText(value, false, path);
      return dialect === 'bigquery' && type === 'Decimal' ? `BIGNUMERIC '${text}'` : text;
    }
    case 'Boolean':
      if (typeof value !== 'boolean') fail('INVALID_FILTER_VALUE', 'Expected true or false', path);
      return value ? 'TRUE' : 'FALSE';
    case 'Date':
      if (!validTemporal(value, DATE)) fail('INVALID_FILTER_VALUE', 'Expected a valid date like "2026-01-31"', path);
      return `DATE '${value}'`;
    case 'DateTime':
      if (!validTemporal(value, DATE, DATETIME)) fail('INVALID_FILTER_VALUE', 'Expected a valid date-time like "2026-01-31 13:45:00"', path);
      return `${dialect === 'bigquery' ? 'DATETIME' : dialect === 'duckdb' ? 'TIMESTAMP' : 'TIMESTAMP_NTZ'} '${value.replace('T', ' ')}'`;
    case 'DateTimeTz':
      if (!validTemporal(value, DATETIME_TZ)) fail('INVALID_FILTER_VALUE', 'Expected a valid date-time with an offset like "2026-01-31T13:45:00Z"', path);
      return `CAST('${value}' AS ${dialect === 'bigquery' ? 'TIMESTAMP' : dialect === 'duckdb' ? 'TIMESTAMPTZ' : 'TIMESTAMP_TZ'})`;
    case 'Time':
      if (!validTemporal(value, TIME)) fail('INVALID_FILTER_VALUE', 'Expected a valid time like "13:45:00"', path);
      return `TIME '${value}'`;
    default:
      fail('UNSUPPORTED_DATATYPE', `Cannot filter a ${type ?? 'field of unknown type'} with this value`, path);
  }
}

// Kept for existing callers: the Snowflake demo adapter and its verifier.
export function snowflakeLiteral(value, datatype, path) {
  return valueLiteral(value, datatype, 'snowflake', path);
}
export function duckdbLiteral(value, datatype, path) {
  return valueLiteral(value, datatype, 'duckdb', path);
}
