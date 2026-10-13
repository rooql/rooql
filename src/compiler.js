import { fail } from './errors.js';
import { GRAINS } from './functions.js';
import { predicate, FILTER_OPERATORS, HAVING_OPERATORS } from './predicates.js';
import { boundedSql } from './limits.js';
import { outputIdentifier, quoteIdentifier } from './identifiers.js';
import { assertModelSnapshot } from './model.js';
import { planJoins } from './planner.js';
import { renderExpression } from './render.js';
import { isNumeric } from './types.js';
import { array, deepFreeze, object } from './validation.js';

const DIALECTS = ['snowflake', 'duckdb', 'bigquery'];
const MAX_LIMIT = 1_000_000_000;

function uniqueName(seen, name, kind, path) {
  const k = name.toLowerCase();
  if (seen.has(k)) fail('DUPLICATE_SELECTION', `Duplicate ${kind} ${name}`, path);
  seen.add(k);
}

export function createRooql(options) {
  object(options, ['model', 'dialect'], 'options');
  const { model, dialect } = options;
  assertModelSnapshot(model);
  if (!DIALECTS.includes(dialect)) fail('UNSUPPORTED_DIALECT', `Supported output dialects are ${DIALECTS.join(' and ')}`, 'options.dialect');
  const ident = name => outputIdentifier(name, dialect);
  const source = ds => ident(dialect === 'bigquery' ? ds.sourceBigquery : ds.source);

  const fieldIndex = new Map();
  for (const ds of model.datasets) for (const field of ds.fields) if (!field.private) fieldIndex.set(field.name.toLowerCase(), field);
  const metricIndex = new Map(model.metrics.filter(m => !m.private).map(m => [m.name.toLowerCase(), m]));
  const describe = item => (item.description ? { description: item.description } : {});
  const catalog = deepFreeze({
    datasets: model.datasets.map(ds => {
      const fields = ds.fields.filter(f => !f.private).map(f => ({ name: f.name, datatype: f.datatype ?? null, ...(f.isTime ? { isTime: true } : {}), ...describe(f) }));
      return { name: ds.name, ...describe(ds), dimensions: fields, fields };
    }),
    relationships: model.relationships.map(({ name, from, to }) => ({ name, from, to })),
    metrics: model.metrics.filter(m => !m.private).map(m => ({ name: m.name, datatype: m.datatype ?? null, ...describe(m) })),
  });

  const lookupField = (name, path) => {
    if (typeof name !== 'string') fail('INVALID_QUERY', 'Expected a dataset.field name', path);
    const field = fieldIndex.get(name.toLowerCase());
    if (!field) fail('UNKNOWN_FIELD', `Unknown field ${name}`, path);
    return field;
  };
  const lookupMetric = (name, path) => {
    if (typeof name !== 'string') fail('INVALID_QUERY', 'Expected a metric name', path);
    const metric = metricIndex.get(name.toLowerCase());
    if (!metric) fail('UNKNOWN_METRIC', `Unknown metric ${name}`, path);
    return metric;
  };

  const compile = query => {
    object(query, ['metrics', 'measures', 'dimensions', 'filters', 'having', 'orderBy', 'limit', 'valueMode'], 'query');
    if (query.valueMode !== undefined && query.valueMode !== 'inline') {
      fail('UNSUPPORTED_VALUE_MODE', 'Values are always escaped and inlined', 'query.valueMode');
    }
    if (query.metrics !== undefined && query.measures !== undefined) fail('INVALID_QUERY', 'Use metrics or measures, not both', 'query');
    const metricKey = query.measures !== undefined ? 'measures' : 'metrics';
    const metricNames = query[metricKey] === undefined ? [] : query[metricKey];
    array(metricNames, `query.${metricKey}`);
    const seenMetrics = new Set();
    const metrics = metricNames.map((name, i) => {
      const metric = lookupMetric(name, `query.${metricKey}[${i}]`);
      uniqueName(seenMetrics, metric.name, 'metric', `query.${metricKey}`);
      return metric;
    });
    if (!metrics.length) fail('INVALID_QUERY', 'Select at least one metric', `query.${metricKey}`);

    const dimensionDocs = (query.dimensions === undefined ? [] : query.dimensions);
    array(dimensionDocs, 'query.dimensions');
    const seenDimensions = new Set();
    const dimensions = dimensionDocs.map((doc, i) => {
      const path = `query.dimensions[${i}]`;
      let name = doc;
      let grain;
      if (doc && typeof doc === 'object') {
        object(doc, ['field', 'grain'], path);
        name = doc.field;
        grain = doc.grain;
      }
      const field = lookupField(name, path);
      if (grain !== undefined) {
        if (!GRAINS.includes(grain)) fail('INVALID_QUERY', `grain must be one of ${GRAINS.join(', ')}`, `${path}.grain`);
        if (!['Date', 'DateTime', 'DateTimeTz'].includes(field.datatype)) {
          fail('GRAIN_NOT_APPLICABLE', `${field.name} is not a Date or DateTime field, so it cannot be grouped by ${grain}`, path);
        }
      }
      uniqueName(seenDimensions, grain ? `${field.name}:${grain}` : field.name, 'dimension', 'query.dimensions');
      const node = grain
        ? { type: 'call', name: 'DATE_TRUNC', part: grain, args: [{ type: 'lit', kind: 'string', value: grain }, field] }
        : field;
      return { field, grain, node };
    });

    const filterDocs = (query.filters === undefined ? [] : query.filters);
    array(filterDocs, 'query.filters');
    const filters = filterDocs.map((filter, i) => {
      const path = `query.filters[${i}]`;
      object(filter, ['field', 'operator', 'value', 'values'], path);
      return { field: lookupField(filter.field, `${path}.field`), filter, path };
    });

    const havingDocs = (query.having === undefined ? [] : query.having);
    array(havingDocs, 'query.having');
    const having = havingDocs.map((condition, i) => {
      const path = `query.having[${i}]`;
      object(condition, ['metric', 'operator', 'value', 'values'], path);
      return { metric: lookupMetric(condition.metric, `${path}.metric`), filter: condition, path };
    });

    const plan = planJoins(model, {
      metrics: [...metrics, ...having.map(h => h.metric)],
      others: [...dimensions.map(d => d.field), ...filters.map(f => f.field)],
    });
    const sql = node => renderExpression(node, dialect, plan.alias);

    const where = filters.map(({ field, filter, path }) => {
      return predicate(sql(field), field.datatype, filter, path, FILTER_OPERATORS, dialect);
    });
    const havingSql = having.map(({ metric, filter, path }) => {
      if (metric.datatype && !isNumeric(metric.datatype)) fail('UNSUPPORTED_OPERATOR', `${metric.name} is not numeric`, path);
      return predicate(sql(metric.expr), metric.datatype ?? 'Decimal', filter, path, HAVING_OPERATORS, dialect);
    });

    const columns = [
      ...dimensions.map(({ field, grain }, i) => ({ alias: `d${i}`, kind: 'dimension', name: field.name, datatype: field.datatype ?? null, ...(grain ? { grain } : {}) })),
      ...metrics.map((metric, i) => ({ alias: `m${i}`, kind: 'metric', name: metric.name, datatype: metric.datatype ?? null })),
    ];

    const orderDocs = (query.orderBy === undefined ? [] : query.orderBy);
    array(orderDocs, 'query.orderBy');
    const orderBy = orderDocs.map((entry, i) => {
      const path = `query.orderBy[${i}]`;
      object(entry, ['field', 'grain', 'direction', 'nulls'], path);
      if (entry.direction !== undefined && typeof entry.direction !== 'string') fail('INVALID_QUERY', 'direction must be asc or desc', `${path}.direction`);
      const direction = (entry.direction ?? 'asc').toLowerCase();
      if (direction !== 'asc' && direction !== 'desc') fail('INVALID_QUERY', 'direction must be asc or desc', `${path}.direction`);
      if (entry.nulls !== undefined && entry.nulls !== 'first' && entry.nulls !== 'last') fail('INVALID_QUERY', 'nulls must be first or last', `${path}.nulls`);
      if (typeof entry.field !== 'string') fail('INVALID_QUERY', 'Expected the name of a selected dimension or metric', `${path}.field`);
      const name = entry.field.toLowerCase();
      const matches = columns.filter(c => c.name.toLowerCase() === name && (entry.grain === undefined || c.grain === entry.grain));
      if (!matches.length) fail('ORDER_BY_NOT_SELECTED', `${entry.field} is not one of the selected dimensions or metrics`, `${path}.field`);
      if (matches.length > 1) fail('INVALID_QUERY', `${entry.field} is selected at several grains; add grain to choose one`, path);
      // Ossie's default: NULL sorts as the highest value (ASC NULLS LAST, DESC NULLS FIRST).
      const nulls = entry.nulls ?? (direction === 'asc' ? 'last' : 'first');
      return `${ident(quoteIdentifier(matches[0].alias))} ${direction.toUpperCase()} NULLS ${nulls.toUpperCase()}`;
    });

    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT)) {
      fail('INVALID_QUERY', `limit must be a whole number from 1 to ${MAX_LIMIT}`, 'query.limit');
    }

    const select = [
      ...dimensions.map(({ node }, i) => `  ${sql(node)} AS ${ident(quoteIdentifier(`d${i}`))}`),
      ...metrics.map((metric, i) => `  ${sql(metric.expr)} AS ${ident(quoteIdentifier(`m${i}`))}`),
    ];
    const anchor = model.datasets.find(ds => ds.key === plan.anchor);
    const lines = ['SELECT', select.join(',\n'), `FROM ${source(anchor)} AS ${ident(plan.alias(anchor.key))}`];
    for (const join of plan.joins) {
      const on = join.on.map(([left, right]) => `${sql(left)} = ${sql(right)}`).join(' AND ');
      lines.push(`LEFT JOIN ${source(join)} AS ${ident(plan.alias(join.dataset))} ON ${on}`);
    }
    if (where.length) lines.push(`WHERE ${where.join(' AND ')}`);
    if (dimensions.length) lines.push(`GROUP BY ${dimensions.map(({ node }) => sql(node)).join(', ')}`);
    if (havingSql.length) lines.push(`HAVING ${havingSql.join(' AND ')}`);
    if (orderBy.length) lines.push(`ORDER BY ${orderBy.join(', ')}`);
    if (query.limit !== undefined) lines.push(`LIMIT ${query.limit}`);
    return deepFreeze({ sql: boundedSql(lines.join('\n')), valueMode: 'inline', dialect, modelHash: model.modelHash, specRevision: model.specRevision, columns });
  };
  return Object.freeze({ compile, catalog: () => catalog });
}
