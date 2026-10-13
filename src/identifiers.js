import { fail } from './errors.js';

export function semanticName(value, path) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail('INVALID_NAME', 'Expected an ASCII semantic name of at most 128 characters beginning with a letter or underscore', path);
  }
  return value;
}

export function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

// Canonical names use SQL double quotes internally. BigQuery uses backticks and escapes.
export function outputIdentifier(value, dialect) {
  if (dialect !== 'bigquery') return value;
  const parts = [...value.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replaceAll('""', '"'));
  return '`' + parts.join('.').replaceAll('\\', '\\\\').replaceAll('`', '\\`') + '`';
}

export function physicalIdentifier(value, maxParts, path, uppercase = true) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail('INVALID_IDENTIFIER', 'Expected a physical identifier', path);
  const parts = [];
  let offset = 0;
  while (offset < value.length) {
    let part;
    if (value[offset] === '"') {
      offset++;
      part = '';
      let closed = false;
      while (offset < value.length) {
        if (value[offset] === '"') {
          if (value[offset + 1] === '"') {
            part += '"';
            offset += 2;
          } else {
            offset++;
            closed = true;
            break;
          }
        } else {
          part += value[offset++];
        }
      }
      if (!closed) fail('INVALID_IDENTIFIER', 'Unclosed quoted identifier', path);
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(value.slice(offset));
      if (!match) fail('INVALID_IDENTIFIER', 'Expected a physical identifier, not SQL', path);
      part = uppercase ? match[0].toUpperCase() : match[0];
      offset += match[0].length;
    }
    if (!part.length || [...part].length > 255 || /[\u0000-\u001f\u007f-\u009f]/.test(part)) {
      fail('INVALID_IDENTIFIER', 'Identifier must contain 1 to 255 characters without control characters', path);
    }
    parts.push(part);
    if (offset === value.length) break;
    if (value[offset++] !== '.' || offset === value.length) {
      fail('INVALID_IDENTIFIER', 'Unexpected text after physical identifier', path);
    }
  }
  if (!parts.length || parts.length > maxParts) {
    fail('INVALID_IDENTIFIER', `Expected 1 to ${maxParts} identifier parts`, path);
  }
  return parts.map(quoteIdentifier).join('.');
}
