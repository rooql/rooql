// Best-effort result datatypes for resolved expressions. Undefined means "not known";
// declared datatypes in the model always win over inference.
import { FUNCTIONS } from './functions.js';

const NUMERIC = ['Integer', 'Decimal', 'Float'];
const widest = types => {
  const known = types.filter(Boolean);
  if (!known.length) return undefined;
  if (known.every(t => NUMERIC.includes(t))) return known.includes('Float') ? 'Float' : known.includes('Decimal') ? 'Decimal' : 'Integer';
  return known.every(t => t === known[0]) ? known[0] : undefined;
};

export function inferType(node) {
  switch (node.type) {
    case 'lit':
      return node.kind === 'number' ? (node.value.includes('.') ? 'Decimal' : 'Integer') : node.kind === 'string' ? 'String' : node.kind === 'boolean' ? 'Boolean' : undefined;
    case 'typed': return { DATE: 'Date', TIME: 'Time', TIMESTAMP: 'DateTime' }[node.kind];
    case 'column': return node.datatype;
    case 'field': return node.datatype ?? inferType(node.expr);
    case 'cast': return { VARCHAR: 'String', BIGINT: 'Integer', DECIMAL: 'Decimal', DOUBLE: 'Float', BOOLEAN: 'Boolean', DATE: 'Date', TIMESTAMP: 'DateTime', TIME: 'Time' }[node.to.name];
    case 'unary': return node.op === 'NOT' ? 'Boolean' : inferType(node.arg);
    case 'isnull': case 'in': case 'between': case 'like': case 'distinctfrom': return 'Boolean';
    case 'case': return widest([...node.whens.map(w => inferType(w.then)), node.else && inferType(node.else)]);
    case 'binary': {
      if (['AND', 'OR', '=', '<>', '<', '>', '<=', '>='].includes(node.op)) return 'Boolean';
      if (node.op === '||') return 'String';
      const types = [inferType(node.left), inferType(node.right)];
      if (node.op === '/') return types.includes('Float') ? 'Float' : types.every(t => NUMERIC.includes(t)) ? 'Decimal' : undefined;
      return widest(types);
    }
    case 'call': {
      const rule = FUNCTIONS[node.name]?.type;
      const args = node.args.map(arg => (arg.type === 'star' ? undefined : inferType(arg)));
      switch (rule) {
        case 'same': case 'first': return args[0];
        case 'second': return args[1];
        case 'dateadd': return args[2] === 'Date' && ['hour', 'minute', 'second'].includes(node.part) ? 'DateTime' : args[2];
        case 'same-numeric': return NUMERIC.includes(args[0]) ? args[0] : undefined;
        case 'average': return args[0] === 'Float' ? 'Float' : NUMERIC.includes(args[0]) ? 'Decimal' : undefined;
        case 'widest': return widest(args);
        case 'widest-tail': return widest(args.slice(1));
        default: return rule;
      }
    }
    default: return undefined;
  }
}

export const isNumeric = type => NUMERIC.includes(type);
