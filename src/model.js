import { fail } from './errors.js';
import { functionSpec } from './functions.js';
import { physicalIdentifier, quoteIdentifier, semanticName } from './identifiers.js';
import { children, parseExpression } from './parse.js';
import { inferType, isNumeric } from './types.js';
import { checkComplexity } from './limits.js';
import { array, deepFreeze, metadata, object, string } from './validation.js';

export const OSSIE_VERSION = '0.2.0.dev0';
export const OSSIE_REVISION = 'dc5138ec6dd8f8f943520f21522f20d5b1c9c619';
const DATATYPES = ['String', 'Integer', 'Decimal', 'Float', 'Boolean', 'Date', 'Time', 'DateTime', 'DateTimeTz', 'Opaque'];
const TEMPORAL = ['Date', 'Time', 'DateTime', 'DateTimeTz'];
// Ossie SQL is the only dialect whose meaning the spec defines. ANSI_SQL expressions are read as
// the same language; vendor dialects are skipped, as the spec allows.
const READABLE_DIALECTS = ['OSSIE_SQL_2026', 'ANSI_SQL'];
const snapshots = new WeakSet();
const key = name => name.toLowerCase();

function chooseExpression(value, path) {
  if (typeof value === 'string') {
    string(value, path, true);
    return { text: value, dialect: 'OSSIE_SQL_2026' };
  }
  object(value, ['dialects'], path);
  array(value.dialects, `${path}.dialects`);
  if (!value.dialects.length) fail('INVALID_SHAPE', 'An expression needs at least one dialect entry', path);
  value.dialects.forEach((entry, index) => {
    object(entry, ['dialect', 'expression'], `${path}.dialects[${index}]`);
    if (entry.dialect !== undefined) string(entry.dialect, `${path}.dialects[${index}].dialect`, true);
    string(entry.expression, `${path}.dialects[${index}].expression`, true);
  });
  // Deterministic choice: Ossie SQL first, then ANSI SQL, then an entry with no dialect (Ossie SQL by default).
  const chosen = value.dialects.find(e => e.dialect === 'OSSIE_SQL_2026')
    ?? value.dialects.find(e => e.dialect === 'ANSI_SQL')
    ?? value.dialects.find(e => e.dialect === undefined);
  if (!chosen) {
    const found = value.dialects.map(e => e.dialect).join(', ');
    fail('UNSUPPORTED_DIALECT', `RooQL reads ${READABLE_DIALECTS.join(' or ')} expressions; this one only has ${found}`, path);
  }
  return { text: chosen.expression, dialect: chosen.dialect ?? 'OSSIE_SQL_2026' };
}

function accessModifier(value, path) {
  if (value === undefined) return false;
  if (value !== 'public' && value !== 'private') fail('INVALID_SHAPE', 'access_modifier must be public or private', path);
  return value === 'private';
}

function keyList(value, path) {
  array(value, path);
  if (!value.length) fail('INVALID_SHAPE', 'A key needs at least one column', path);
  const columns = value.map((name, index) => physicalIdentifier(name, 1, `${path}[${index}]`));
  if (new Set(columns).size !== columns.length) fail('INVALID_SHAPE', 'Key columns must be distinct', path);
  return columns;
}

// Checks a resolved expression: known functions, aggregate placement, and DATEADD typing.
function checkExpression(node, { allowAggregates, path }) {
  checkComplexity(node, path);
  let aggregates = 0;
  const visit = (current, inAggregate) => {
    if (current.type === 'call') {
      const spec = functionSpec(current, path);
      if (spec.kind === 'aggregate') {
        if (!allowAggregates) fail('AGGREGATE_IN_FIELD', `${current.name} is an aggregate; field expressions are row-level. Define it as a metric instead`, path);
        if (inAggregate) fail('NESTED_AGGREGATE', `${current.name} is nested inside another aggregate, which Ossie defers`, path);
        aggregates++;
        current.args.forEach(arg => visit(arg, true));
        const type = inferType(current.args[0]);
        if (spec.numeric && type && !isNumeric(type)) fail('INVALID_METRIC_TYPE', `${current.name} needs a numeric argument`, path);
        return;
      }
    }
    if (allowAggregates && !inAggregate && (current.type === 'field' || current.type === 'column')) {
      fail('UNAGGREGATED_FIELD', `${current.name ?? 'A column'} is used outside an aggregate; wrap it in SUM, COUNT, MIN, MAX or similar`, path);
    }
    if (current.type === 'field') return; // fields were checked when they were resolved
    for (const child of children(current)) visit(child, inAggregate);
    if (current.type === 'call' && current.name === 'DATEADD') {
      const amountType = inferType(current.args[1]);
      if (amountType && amountType !== 'Integer') fail('UNSUPPORTED_EXPRESSION', 'DATEADD needs an integer amount', path);
      current.dateTyped = inferType(current) === 'Date';
    }
  };
  visit(node, false);
  return aggregates;
}

export function assertModelSnapshot(model) {
  if (!model || !snapshots.has(model)) fail('INVALID_MODEL', 'Load a validated snapshot with loadOssieModel first');
}

export async function loadOssieModel(jsonText) {
  if (typeof jsonText !== 'string') fail('INVALID_MODEL', 'Expected Ossie JSON text');
  if (!jsonText.isWellFormed()) fail('INVALID_MODEL', 'JSON text contains an unpaired surrogate');
  let document;
  try {
    document = JSON.parse(jsonText);
  } catch {
    fail('INVALID_JSON', 'Could not parse Ossie JSON text');
  }
  object(document, ['version', 'name', 'description', 'ai_context', 'datasets', 'relationships', 'metrics', 'custom_extensions'], 'model');
  if (document.version !== OSSIE_VERSION) fail('UNSUPPORTED_VERSION', `Expected Ossie version ${OSSIE_VERSION}`, 'model.version');
  string(document.name, 'model.name', true);
  metadata(document, 'model');
  array(document.datasets, 'model.datasets');
  if (!document.datasets.length) fail('INVALID_SHAPE', 'A model needs at least one dataset', 'model.datasets');
  const relationshipDocs = document.relationships === undefined ? [] : document.relationships;
  array(relationshipDocs, 'model.relationships');
  const metricDocs = document.metrics === undefined ? [] : document.metrics;
  array(metricDocs, 'model.metrics');

  // Datasets, relationships and metrics share one global namespace.
  const globals = new Map();
  const claim = (name, kind, path) => {
    semanticName(name, `${path}.name`);
    const k = key(name);
    if (globals.has(k)) fail(globals.get(k) === kind ? 'DUPLICATE_NAME' : 'NAME_COLLISION', `${kind} ${name} reuses the name of a ${globals.get(k)}`, path);
    globals.set(k, kind);
  };

  const datasets = new Map();
  document.datasets.forEach((ds, index) => {
    const path = `model.datasets[${index}]`;
    object(ds, ['name', 'source', 'primary_key', 'unique_keys', 'description', 'ai_context', 'fields', 'custom_extensions'], path);
    claim(ds?.name, 'dataset', path);
    metadata(ds, path);
    string(ds.source, `${path}.source`, true);
    if (/^\s*\(?\s*(select|with)\b/i.test(ds.source)) {
      fail('UNSUPPORTED_FEATURE', 'Dataset sources must be a table or view name; SQL query sources are not supported yet', `${path}.source`);
    }
    const fieldDocs = ds.fields === undefined ? [] : ds.fields;
    array(fieldDocs, `${path}.fields`);
    const fieldNames = new Set();
    fieldDocs.forEach((field, fi) => {
      const fpath = `${path}.fields[${fi}]`;
      object(field, ['name', 'expression', 'dimension', 'label', 'description', 'datatype', 'ai_context', 'custom_extensions', 'access_modifier'], fpath);
      semanticName(field.name, `${fpath}.name`);
      if (fieldNames.has(key(field.name))) fail('DUPLICATE_NAME', `Duplicate field ${field.name}`, `${path}.fields`);
      fieldNames.add(key(field.name));
    });
    const source = ds.source.replace(/"(?:[^"]|"")*"|`([^`]*)`/g, (match, part) => part === undefined ? match : quoteIdentifier(part));
    datasets.set(key(ds.name), {
      doc: ds, path, key: key(ds.name), name: ds.name,
      // Backtick quoting (MySQL, BigQuery) names a table just as unambiguously as double quotes.
      source: physicalIdentifier(source, 3, `${path}.source`),
      sourceBigquery: physicalIdentifier(source, 3, `${path}.source`, false),
      primaryKey: ds.primary_key === undefined ? undefined : keyList(ds.primary_key, `${path}.primary_key`),
      uniqueKeys: (ds.unique_keys === undefined ? [] : (array(ds.unique_keys, `${path}.unique_keys`), ds.unique_keys)).map((uk, ui) => keyList(uk, `${path}.unique_keys[${ui}]`)),
      fieldDocs: new Map(fieldDocs.map((field, fi) => [key(field.name), { doc: field, path: `${path}.fields[${fi}]` }])),
      fields: new Map(),
    });
  });
  relationshipDocs.forEach((rel, index) => claim(rel?.name, 'relationship', `model.relationships[${index}]`));
  metricDocs.forEach((metric, index) => claim(metric?.name, 'metric', `model.metrics[${index}]`));

  // Fields resolve lazily so that one field may reference another on the same dataset.
  const resolving = new Set();
  const resolveField = (dsKey, fieldKey, path) => {
    const ds = datasets.get(dsKey);
    if (ds.fields.has(fieldKey)) return ds.fields.get(fieldKey);
    const entry = ds.fieldDocs.get(fieldKey);
    if (!entry) fail('UNKNOWN_FIELD', `Unknown field ${ds.name}.${fieldKey}`, path);
    const id = `${dsKey}.${fieldKey}`;
    if (resolving.has(id)) fail('CYCLIC_REFERENCE', `Field ${ds.name}.${entry.doc.name} refers to itself`, entry.path);
    if (resolving.size >= 64) fail('EXPRESSION_TOO_COMPLEX', 'Reference depth exceeds 64', path);
    resolving.add(id);
    const { doc, path: fpath } = entry;
    metadata(doc, fpath);
    if (doc.datatype !== undefined && !DATATYPES.includes(doc.datatype)) fail('UNSUPPORTED_DATATYPE', `datatype must be one of ${DATATYPES.join(', ')}`, `${fpath}.datatype`);
    let explicitTime;
    if (doc.dimension !== undefined) {
      object(doc.dimension, ['is_time'], `${fpath}.dimension`);
      if (doc.dimension.is_time !== undefined && typeof doc.dimension.is_time !== 'boolean') fail('INVALID_SHAPE', 'is_time must be true or false', `${fpath}.dimension.is_time`);
      explicitTime = doc.dimension.is_time;
    }
    const { text, dialect } = chooseExpression(doc.expression, `${fpath}.expression`);
    const ast = parseExpression(text, `${fpath}.expression`);
    checkComplexity(ast, `${fpath}.expression`);
    const resolved = resolveRefs(ast, ref => {
      if (ref.parts.length === 1) {
        const part = ref.parts[0];
        const column = quoteIdentifier(part.quoted ? part.name : part.name.toUpperCase());
        // A sibling field that is exactly this column lends the column its declared datatype.
        const sibling = ds.fieldDocs.get(key(part.name))?.doc;
        const siblingText = sibling && (typeof sibling.expression === 'string' ? sibling.expression
          : sibling.expression?.dialects?.find(e => READABLE_DIALECTS.includes(e.dialect ?? 'OSSIE_SQL_2026'))?.expression);
        const datatype = siblingText?.trim().toLowerCase() === part.name.toLowerCase() && DATATYPES.includes(sibling.datatype) ? sibling.datatype : undefined;
        return { type: 'column', dataset: dsKey, column, name: `${ds.name}.${doc.name}`, ...(datatype ? { datatype } : {}) };
      }
      if (ref.parts.length === 2) {
        const target = key(ref.parts[0].name);
        if (target === dsKey) return resolveField(dsKey, key(ref.parts[1].name), `${fpath}.expression`);
        if (datasets.has(target)) fail('UNSUPPORTED_FEATURE', `Field expressions can only use their own dataset's columns; move logic that uses ${ref.parts[0].name} into a metric`, `${fpath}.expression`);
        fail('UNKNOWN_DATASET', `Unknown dataset ${ref.parts[0].name}`, `${fpath}.expression`);
      }
      fail('INVALID_IDENTIFIER', 'Field expressions use column names or dataset.field references', `${fpath}.expression`);
    });
    checkExpression(resolved, { allowAggregates: false, path: `${fpath}.expression` });
    const datatype = doc.datatype ?? inferType(resolved);
    const plain = resolved.type === 'column' ? resolved.column : undefined;
    const field = {
      type: 'field', dataset: dsKey, name: `${ds.name}.${doc.name}`, datatype,
      isTime: explicitTime ?? TEMPORAL.includes(datatype),
      private: accessModifier(doc.access_modifier, `${fpath}.access_modifier`),
      description: doc.description, dialect, expression: text, expr: resolved,
      ...(plain ? { column: plain } : {}),
    };
    resolving.delete(id);
    ds.fields.set(fieldKey, field);
    return field;
  };
  for (const ds of datasets.values()) for (const fieldKey of ds.fieldDocs.keys()) resolveField(ds.key, fieldKey);

  const relationships = relationshipDocs.map((rel, index) => {
    const path = `model.relationships[${index}]`;
    object(rel, ['name', 'from', 'to', 'from_columns', 'to_columns', 'description', 'ai_context', 'custom_extensions'], path);
    metadata(rel, path);
    for (const end of ['from', 'to']) {
      string(rel[end], `${path}.${end}`, true);
      if (!datasets.has(key(rel[end]))) fail('UNKNOWN_DATASET', `Unknown dataset ${rel[end]}`, `${path}.${end}`);
    }
    const from = datasets.get(key(rel.from));
    const to = datasets.get(key(rel.to));
    if (from === to) fail('UNSUPPORTED_FEATURE', 'Self-relationships are not supported yet', path);
    const fromColumns = keyList(rel.from_columns, `${path}.from_columns`);
    const toColumns = keyList(rel.to_columns, `${path}.to_columns`);
    if (fromColumns.length !== toColumns.length) fail('INVALID_SHAPE', 'from_columns and to_columns need the same number of columns', path);
    // Keys refer to physical columns, never to same-named computed fields.
    const side = (ds, column) => ({ type: 'column', dataset: ds.key, column });
    const pairs = fromColumns.map((column, i) => [side(from, column), side(to, toColumns[i])]);
    // The core spec declares from = many side, to = one side. Keys on the from side make it 1:1.
    const sameSet = (a, b) => b && a.length === b.length && a.every(c => b.includes(c));
    const oneToOne = sameSet(fromColumns, from.primaryKey) || from.uniqueKeys.some(uk => sameSet(fromColumns, uk));
    return { name: rel.name, from: from.key, to: to.key, pairs, oneToOne };
  });

  const metricEntries = new Map(metricDocs.map((doc, index) => [key(doc.name), { doc, path: `model.metrics[${index}]` }]));
  const metrics = new Map();
  const resolveMetric = (metricKey, path) => {
    if (metrics.has(metricKey)) return metrics.get(metricKey);
    const entry = metricEntries.get(metricKey);
    if (!entry) fail('UNKNOWN_METRIC', `Unknown metric ${metricKey}`, path);
    if (resolving.has(`metric:${metricKey}`)) fail('CYCLIC_REFERENCE', `Metric ${entry.doc.name} refers to itself`, entry.path);
    if (resolving.size >= 64) fail('EXPRESSION_TOO_COMPLEX', 'Reference depth exceeds 64', path);
    resolving.add(`metric:${metricKey}`);
    const { doc, path: mpath } = entry;
    object(doc, ['name', 'expression', 'description', 'datatype', 'ai_context', 'custom_extensions', 'access_modifier'], mpath);
    metadata(doc, mpath);
    if (doc.datatype !== undefined && !DATATYPES.includes(doc.datatype)) fail('UNSUPPORTED_DATATYPE', `datatype must be one of ${DATATYPES.join(', ')}`, `${mpath}.datatype`);
    const { text, dialect } = chooseExpression(doc.expression, `${mpath}.expression`);
    const epath = `${mpath}.expression`;
    const ast = parseExpression(text, epath);
    checkComplexity(ast, epath);
    const resolved = resolveRefs(ast, ref => {
      if (ref.parts.length === 1) {
        const name = key(ref.parts[0].name);
        if (metricEntries.has(name)) return resolveMetric(name, epath).expr;
        fail('UNKNOWN_METRIC', `Unknown metric ${ref.parts[0].name}; refer to fields as dataset.field`, epath);
      }
      if (ref.parts.length === 2) {
        const dsKey = key(ref.parts[0].name);
        if (!datasets.has(dsKey)) fail('UNKNOWN_DATASET', `Unknown dataset ${ref.parts[0].name}`, epath);
        const ds = datasets.get(dsKey);
        const field = ds.fields.get(key(ref.parts[1].name));
        if (field) return field;
        // Many real models aggregate columns they never declared as fields; read those as the
        // dataset's physical column. A typo then fails in the warehouse, not as a wrong number.
        const part = ref.parts[1];
        return { type: 'column', dataset: dsKey, column: quoteIdentifier(part.quoted ? part.name : part.name.toUpperCase()), name: `${ds.name}.${part.name}` };
      }
      fail('INVALID_IDENTIFIER', 'Metric expressions use metric names or dataset.field references', epath);
    });
    // A referenced metric is inlined; its own aggregates are checked as part of this tree.
    if (checkExpression(resolved, { allowAggregates: true, path: epath }) === 0) {
      fail('METRIC_WITHOUT_AGGREGATE', 'A metric needs at least one aggregate such as SUM or COUNT', epath);
    }
    const metric = {
      name: doc.name, datatype: doc.datatype ?? inferType(resolved), description: doc.description,
      private: accessModifier(doc.access_modifier, `${mpath}.access_modifier`), dialect, expression: text, expr: resolved,
    };
    resolving.delete(`metric:${metricKey}`);
    metrics.set(metricKey, metric);
    return metric;
  };
  for (const metricKey of metricEntries.keys()) resolveMetric(metricKey);

  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsonText));
  const modelHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const snapshot = deepFreeze({
    name: document.name, version: OSSIE_VERSION, specRevision: OSSIE_REVISION, modelHash,
    datasets: [...datasets.values()].map(ds => ({
      name: ds.name, key: ds.key, source: ds.source, sourceBigquery: ds.sourceBigquery, primaryKey: ds.primaryKey, uniqueKeys: ds.uniqueKeys,
      description: ds.doc.description, fields: [...ds.fields.values()],
    })),
    relationships,
    metrics: [...metrics.values()],
  });
  snapshots.add(snapshot);
  return snapshot;
}

// Rebuilds an expression tree, replacing each ref with what the resolver returns.
function resolveRefs(node, resolver) {
  if (node.type === 'ref') return resolver(node);
  const copy = { ...node };
  for (const [prop, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      copy[prop] = value.map(item => (item && typeof item === 'object' && 'when' in item
        ? { when: resolveRefs(item.when, resolver), then: resolveRefs(item.then, resolver) }
        : item && typeof item === 'object' && item.type ? resolveRefs(item, resolver) : item));
    } else if (value && typeof value === 'object' && value.type) {
      copy[prop] = resolveRefs(value, resolver);
    }
  }
  return copy;
}
