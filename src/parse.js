// Parser for the Ossie SQL expression subset (OSSIE_SQL_2026, and ANSI_SQL read as the same
// language). Produces a plain AST; nothing here knows about datasets or dialects.
import { fail } from './errors.js';

const MAX_LENGTH = 16384;
const MAX_TOKENS = 2048;
const MAX_DEPTH = 64;
const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE', 'DISTINCT', 'AS', 'FROM', 'OVER', 'WITHIN', 'SELECT']);
const TYPED_LITERALS = { DATE: 'DATE', TIME: 'TIME', TIMESTAMP: 'TIMESTAMP', TIMESTAMP_NTZ: 'TIMESTAMP' };
const NILADIC = new Set(['CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME']);
const EXTRACT_PARTS = new Set(['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND']);
const CAST_TYPES = {
  VARCHAR: 'VARCHAR', STRING: 'VARCHAR', TEXT: 'VARCHAR',
  INTEGER: 'BIGINT', INT: 'BIGINT', BIGINT: 'BIGINT',
  DECIMAL: 'DECIMAL', NUMERIC: 'DECIMAL', NUMBER: 'DECIMAL',
  FLOAT: 'DOUBLE', DOUBLE: 'DOUBLE',
  BOOLEAN: 'BOOLEAN', DATE: 'DATE', TIMESTAMP: 'TIMESTAMP', TIMESTAMP_NTZ: 'TIMESTAMP', TIME: 'TIME',
};

export function tokenize(text, path) {
  if (typeof text !== 'string' || !text.trim().length || text.length > MAX_LENGTH) {
    fail('UNSUPPORTED_EXPRESSION', `Expected an expression of 1 to ${MAX_LENGTH} characters`, path);
  }
  const tokens = [];
  let i = 0;
  const at = () => `at character ${i}`;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('--', i) || text.startsWith('/*', i)) fail('UNSUPPORTED_EXPRESSION', `Comments are not allowed in expressions (${at()})`, path);
    if (c === "'" || c === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= text.length) fail('UNSUPPORTED_EXPRESSION', `Unclosed ${c === "'" ? 'string' : 'quoted identifier'} (${at()})`, path);
        if (text[j] === c) {
          if (text[j + 1] === c) { value += c; j += 2; continue; }
          break;
        }
        value += text[j++];
      }
      tokens.push({ t: c === "'" ? 'str' : 'qid', v: value, at: i });
      i = j + 1;
    } else if (/[0-9.]/.test(c) && /^(\d+\.?\d*|\.\d+)/.test(text.slice(i))) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
      tokens.push({ t: 'num', v: match[0], at: i });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i));
      tokens.push({ t: 'id', v: match[0], up: match[0].toUpperCase(), at: i });
      i += match[0].length;
    } else {
      const op = ['<=', '>=', '<>', '!=', '||'].find(o => text.startsWith(o, i)) || ('=<>+-*/%(),.'.includes(c) ? c : null);
      if (!op) fail('UNSUPPORTED_EXPRESSION', `Unexpected character ${JSON.stringify(c)} (${at()})`, path);
      tokens.push({ t: 'op', v: op === '!=' ? '<>' : op, at: i });
      i += op.length;
    }
    if (tokens.length > MAX_TOKENS) fail('UNSUPPORTED_EXPRESSION', `Expression exceeds ${MAX_TOKENS} tokens`, path);
  }
  return tokens;
}

export function parseExpression(text, path) {
  const tokens = tokenize(text, path);
  let p = 0;
  let depth = 0;
  const peek = (o = 0) => tokens[p + o];
  const isKw = (word, o = 0) => peek(o)?.t === 'id' && peek(o).up === word;
  const isOp = (op, o = 0) => peek(o)?.t === 'op' && peek(o).v === op;
  const where = () => (peek() ? `at character ${peek().at}` : 'at the end');
  const error = message => fail('UNSUPPORTED_EXPRESSION', `${message} ${where()}`, path);
  const takeKw = word => { if (!isKw(word)) error(`Expected ${word}`); p++; };
  const takeOp = op => { if (!isOp(op)) error(`Expected ${op}`); p++; };
  const nest = fn => {
    if (++depth > MAX_DEPTH) error('Expression nesting is too deep');
    try { return fn(); } finally { depth--; }
  };

  const expr = () => nest(or);
  const or = () => {
    let node = and();
    while (isKw('OR')) { p++; node = { type: 'binary', op: 'OR', left: node, right: and() }; }
    return node;
  };
  const and = () => {
    let node = not();
    while (isKw('AND')) { p++; node = { type: 'binary', op: 'AND', left: node, right: not() }; }
    return node;
  };
  const not = () => {
    if (isKw('NOT')) { p++; return { type: 'unary', op: 'NOT', arg: nest(not) }; }
    return predicate();
  };
  const predicate = () => {
    const left = additive();
    const op = peek();
    if (op?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(op.v)) {
      p++;
      return { type: 'binary', op: op.v, left, right: additive() };
    }
    if (isKw('IS')) {
      p++;
      const negated = isKw('NOT') ? (p++, true) : false;
      if (isKw('NULL')) { p++; return { type: 'isnull', arg: left, negated }; }
      if (isKw('DISTINCT')) { p++; takeKw('FROM'); return { type: 'distinctfrom', left, right: additive(), negated }; }
      error('Expected NULL or DISTINCT FROM after IS');
    }
    const negated = isKw('NOT') && (isKw('IN', 1) || isKw('BETWEEN', 1) || isKw('LIKE', 1) || isKw('ILIKE', 1)) ? (p++, true) : false;
    if (isKw('IN')) {
      p++;
      takeOp('(');
      if (isKw('SELECT')) error('Subqueries are not supported');
      const list = [expr()];
      while (isOp(',')) { p++; list.push(expr()); }
      takeOp(')');
      return { type: 'in', arg: left, list, negated };
    }
    if (isKw('BETWEEN')) {
      p++;
      const low = additive();
      takeKw('AND');
      return { type: 'between', arg: left, low, high: additive(), negated };
    }
    if (isKw('LIKE') || isKw('ILIKE')) {
      const ilike = peek().up === 'ILIKE';
      p++;
      return { type: 'like', arg: left, pattern: additive(), ilike, negated };
    }
    if (negated) error('Expected IN, BETWEEN or LIKE after NOT');
    return left;
  };
  const additive = () => {
    let node = multiplicative();
    while (isOp('+') || isOp('-') || isOp('||')) {
      const op = tokens[p++].v;
      node = { type: 'binary', op, left: node, right: multiplicative() };
    }
    return node;
  };
  const multiplicative = () => {
    let node = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[p++].v;
      node = { type: 'binary', op, left: node, right: unary() };
    }
    return node;
  };
  const unary = () => {
    if (isOp('-') || isOp('+')) {
      const op = tokens[p++].v;
      const arg = nest(unary);
      if (op === '-' && arg.type === 'lit' && arg.kind === 'number' && !arg.value.startsWith('-')) return { ...arg, value: `-${arg.value}` };
      return op === '-' ? { type: 'unary', op: '-', arg } : arg;
    }
    return primary();
  };
  const identifierPart = () => {
    const token = peek();
    if (token?.t === 'qid') { p++; return { name: token.v, quoted: true }; }
    if (token?.t === 'id' && !KEYWORDS.has(token.up)) { p++; return { name: token.v, quoted: false }; }
    error('Expected an identifier');
  };
  const castType = () => {
    const token = peek();
    if (token?.t !== 'id' || !CAST_TYPES[token.up]) error('Unsupported CAST target type');
    p++;
    const name = CAST_TYPES[token.up];
    if (name !== 'DECIMAL') {
      if (isOp('(')) error(`${token.v} does not take a size here`);
      return { name };
    }
    // Snowflake and DuckDB disagree on DECIMAL's default precision and scale, so require them.
    if (!isOp('(')) error('DECIMAL needs an explicit precision and scale, like DECIMAL(18, 2)');
    p++;
    const precision = peek();
    if (precision?.t !== 'num' || !/^\d+$/.test(precision.v)) error('Expected a precision');
    p++;
    takeOp(',');
    const scale = peek();
    if (scale?.t !== 'num' || !/^\d+$/.test(scale.v)) error('Expected a scale');
    p++;
    takeOp(')');
    if (Number(precision.v) < 1 || Number(precision.v) > 38 || Number(scale.v) > Number(precision.v)) error('DECIMAL precision must be 1 to 38 and at least the scale');
    return { name, precision: Number(precision.v), scale: Number(scale.v) };
  };
  const primary = () => {
    const token = peek();
    if (!token) error('Unexpected end of expression');
    if (token.t === 'num') {
      p++;
      if (/[eE]/.test(token.v)) error('Exponent notation is not supported in numbers');
      return { type: 'lit', kind: 'number', value: token.v.startsWith('.') ? `0${token.v}` : token.v.replace(/\.$/, '') };
    }
    if (token.t === 'str') { p++; return { type: 'lit', kind: 'string', value: token.v }; }
    if (isOp('(')) {
      p++;
      if (isKw('SELECT')) error('Subqueries are not supported');
      const node = expr();
      takeOp(')');
      return node;
    }
    if (isOp('*')) error('* is only allowed inside COUNT(*)');
    if (token.t === 'id') {
      const up = token.up;
      if (up === 'NULL') { p++; return { type: 'lit', kind: 'null' }; }
      if (up === 'TRUE' || up === 'FALSE') { p++; return { type: 'lit', kind: 'boolean', value: up === 'TRUE' }; }
      if (up === 'CASE') return caseExpression();
      if (TYPED_LITERALS[up] && peek(1)?.t === 'str') {
        p += 2;
        return { type: 'typed', kind: TYPED_LITERALS[up], value: tokens[p - 1].v };
      }
      if (NILADIC.has(up) && !isOp('(', 1)) { p++; return { type: 'call', name: up, args: [] }; }
      if ((up === 'CAST' || up === 'TRY_CAST') && isOp('(', 1)) {
        p += 2;
        const arg = expr();
        takeKw('AS');
        const to = castType();
        takeOp(')');
        return { type: 'cast', arg, to, try: up === 'TRY_CAST' };
      }
      if (up === 'EXTRACT' && isOp('(', 1)) {
        p += 2;
        const part = peek();
        if (part?.t !== 'id' || !EXTRACT_PARTS.has(part.up)) error('Unsupported EXTRACT part');
        p++;
        takeKw('FROM');
        const arg = expr();
        takeOp(')');
        return { type: 'call', name: part.up, args: [arg] };
      }
      if (isOp('(', 1) && !KEYWORDS.has(up)) return call();
    }
    const parts = [identifierPart()];
    while (isOp('.')) { p++; parts.push(identifierPart()); }
    return { type: 'ref', parts };
  };
  const call = () => {
    const name = tokens[p].up;
    p += 2;
    const node = { type: 'call', name, args: [] };
    if (isOp('*')) {
      p++;
      node.args.push({ type: 'star' });
    } else if (!isOp(')')) {
      if (isKw('DISTINCT')) { p++; node.distinct = true; }
      node.args.push(expr());
      while (isOp(',')) { p++; node.args.push(expr()); }
    }
    takeOp(')');
    // DATEADD(day, ...) and DATEDIFF(day, ...) take a bare date-part keyword, not a column.
    const part = node.args[0];
    if (['DATEADD', 'DATEDIFF'].includes(name) && part?.type === 'ref' && part.parts.length === 1 && !part.parts[0].quoted) {
      node.args[0] = { type: 'lit', kind: 'string', value: part.parts[0].name };
    }
    if (isKw('OVER')) error('Window functions are not supported yet');
    if (isKw('WITHIN')) error('WITHIN GROUP aggregates are not supported yet');
    return node;
  };
  const caseExpression = () => {
    p++;
    const node = { type: 'case', whens: [] };
    if (!isKw('WHEN')) node.operand = expr();
    while (isKw('WHEN')) {
      p++;
      const when = expr();
      takeKw('THEN');
      node.whens.push({ when, then: expr() });
    }
    if (!node.whens.length) error('CASE needs at least one WHEN');
    if (isKw('ELSE')) { p++; node.else = expr(); }
    takeKw('END');
    return node;
  };

  const node = expr();
  if (p !== tokens.length) error('Unexpected text');
  return node;
}

// Every node type, for walkers that must see the whole tree.
export function children(node) {
  switch (node.type) {
    case 'binary': return [node.left, node.right];
    case 'unary': case 'isnull': case 'cast': return [node.arg];
    case 'call': return node.args;
    case 'case': return [node.operand, ...node.whens.flatMap(w => [w.when, w.then]), node.else].filter(Boolean);
    case 'in': return [node.arg, ...node.list];
    case 'between': return [node.arg, node.low, node.high];
    case 'like': return [node.arg, node.pattern];
    case 'distinctfrom': return [node.left, node.right];
    case 'field': return [node.expr];
    default: return [];
  }
}
