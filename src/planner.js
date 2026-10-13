// Star-join planner. Chooses an anchor dataset (the fact whose rows the metrics aggregate) and
// LEFT JOINs out to every other dataset the query needs along many-to-one (or one-to-one)
// relationships. It refuses, with a typed error, any query where joining would double-count
// rows, needs two facts at once, or has more than one possible join path.
import { fail } from './errors.js';
import { FUNCTIONS } from './functions.js';
import { children } from './parse.js';

export function datasetsIn(nodes) {
  const found = new Set();
  const visit = node => {
    if (node.type === 'column' || node.type === 'field') found.add(node.dataset);
    if (node.type === 'column') return;
    for (const child of children(node)) visit(child);
  };
  nodes.forEach(visit);
  return found;
}

function aggregatesIn(node, list = []) {
  if (node.type === 'call' && FUNCTIONS[node.name]?.kind === 'aggregate') {
    const spec = FUNCTIONS[node.name];
    list.push({
      name: node.name,
      datasets: datasetsIn(node.args.filter(arg => arg.type !== 'star')),
      // Repeating input rows cannot change these results.
      duplicateSafe: Boolean(spec.duplicateSafe || (node.name === 'COUNT' && node.distinct)),
    });
    return list;
  }
  for (const child of children(node)) aggregatesIn(child, list);
  return list;
}

// Edges walkable from a dataset: from the many side to the one side, and both ways when 1:1.
function edgesOf(model) {
  const edges = new Map(model.datasets.map(ds => [ds.key, []]));
  for (const rel of model.relationships) {
    edges.get(rel.from).push({ to: rel.to, rel, pairs: rel.pairs, sameGrain: rel.oneToOne });
    if (rel.oneToOne) edges.get(rel.to).push({ to: rel.from, rel, pairs: rel.pairs.map(([a, b]) => [b, a]), sameGrain: true });
  }
  return edges;
}

// Up to two simple paths from start to target, as lists of edges.
function pathsBetween(edges, start, target) {
  const found = [];
  const visit = (node, seen, path) => {
    if (found.length > 1) return;
    if (node === target) { found.push(path); return; }
    for (const edge of edges.get(node)) {
      if (seen.has(edge.to) || path.length > 12) continue;
      seen.add(edge.to);
      visit(edge.to, seen, [...path, edge]);
      seen.delete(edge.to);
    }
  };
  visit(start, new Set([start]), []);
  return found;
}

const names = (model, keys) => [...keys].map(k => model.datasets.find(ds => ds.key === k).name).join(', ');

// metrics: [{ name, expr }]; others: dimension and filter nodes.
export function planJoins(model, { metrics, others }) {
  const touched = datasetsIn([...metrics.map(m => m.expr), ...others]);
  const aggregates = metrics.flatMap(metric => aggregatesIn(metric.expr).map(agg => ({ ...agg, metric: metric.name })));
  const order = model.datasets.map(ds => ds.key);
  if (touched.size === 0) {
    if (model.datasets.length === 1) return { anchor: order[0], joins: [], alias: () => '"t0"' };
    fail('AMBIGUOUS_ANCHOR', 'This query does not say which dataset to count; use COUNT(dataset.field) instead of COUNT(*), or add a metric from the fact table');
  }

  // In a model with several datasets, COUNT(*) alone does not say whose rows to count.
  if (model.datasets.length > 1 && aggregates.length && aggregates.every(agg => !agg.datasets.size)) {
    fail('AMBIGUOUS_ANCHOR', `${aggregates[0].metric} counts rows with COUNT(*), but this model has several datasets; use COUNT(dataset.key) or add a metric from the fact table`);
  }
  const edges = edgesOf(model);
  const aggregateHomes = new Set(aggregates.flatMap(agg => [...agg.datasets]));
  // Try the datasets that metrics aggregate first, then the rest, in model order.
  const candidates = [...order.filter(k => aggregateHomes.has(k)), ...order.filter(k => touched.has(k) && !aggregateHomes.has(k))];
  const failures = [];
  const valid = [];
  for (const anchor of candidates) {
    // A metric's own dataset defines its population; dimensions are fallback anchors only.
    if (valid.length && aggregateHomes.has(valid[0].anchor) && !aggregateHomes.has(anchor)) break;
    const routes = new Map();
    let problem;
    for (const target of touched) {
      if (target === anchor) continue;
      const paths = pathsBetween(edges, anchor, target);
      if (!paths.length) { problem = { kind: 'unreachable', target }; break; }
      if (paths.length > 1) { problem = { kind: 'ambiguous', target, paths }; break; }
      routes.set(target, paths[0]);
    }
    if (!problem) {
      for (const agg of aggregates) {
        if (!agg.datasets.size || agg.datasets.has(anchor) || agg.duplicateSafe) continue;
        // An aggregate over a coarser dataset repeats once per anchor row, unless every hop is 1:1.
        if ([...agg.datasets].every(ds => routes.get(ds).every(edge => edge.sameGrain))) continue;
        problem = { kind: 'fanout', agg };
        break;
      }
    }
    if (!problem) valid.push({ anchor, routes });
    else failures.push({ anchor, ...problem });
  }

  if (valid.length > 1) fail('AMBIGUOUS_ANCHOR', `Several datasets can anchor these metrics (${names(model, valid.map(p => p.anchor))}); one-to-one keys do not guarantee matching populations. Run one query per dataset`);
  if (valid.length) return buildPlan(model, valid[0].anchor, valid[0].routes);

  const fanout = failures.find(f => f.kind === 'fanout');
  const ambiguous = failures.find(f => f.kind === 'ambiguous');
  if (fanout) {
    const { agg, anchor } = fanout;
    fail('FANOUT_UNSAFE', `${agg.metric} uses ${agg.name} over ${names(model, agg.datasets)}, which repeats once per ${names(model, [anchor])} row when joined, so it would be double-counted. Group by ${names(model, agg.datasets)} fields only, or use COUNT(DISTINCT), MIN or MAX`);
  }
  if (ambiguous) {
    const via = ambiguous.paths.map(path => path.map(edge => edge.rel.name).join(' → ')).join(' or ');
    fail('AMBIGUOUS_PATH', `${names(model, [ambiguous.anchor])} reaches ${names(model, [ambiguous.target])} in more than one way (${via}); RooQL won't guess which one you mean`);
  }
  if (aggregateHomes.size > 1 && candidates.filter(c => aggregateHomes.has(c)).every(c => failures.find(f => f.anchor === c)?.kind === 'unreachable')) {
    fail('MULTI_FACT_UNSUPPORTED', `The metrics aggregate ${names(model, aggregateHomes)}, which are separate facts with no many-to-one path between them; querying them together is not supported yet. Run one query per fact and combine the results`);
  }
  fail('NO_PATH', `No many-to-one join path connects ${names(model, touched)} from a single dataset`);
}

function buildPlan(model, anchor, routes) {
  const aliases = new Map([[anchor, '"t0"']]);
  const joins = [];
  // Join in model order of the datasets each route reaches, intermediate hops first.
  const targets = model.datasets.map(ds => ds.key).filter(k => routes.has(k));
  for (const target of targets) {
    for (const edge of routes.get(target)) {
      if (!aliases.has(edge.to)) {
        aliases.set(edge.to, `"t${aliases.size}"`);
        const ds = model.datasets.find(d => d.key === edge.to);
        joins.push({ dataset: edge.to, source: ds.source, sourceBigquery: ds.sourceBigquery, on: edge.pairs });
      }
    }
  }
  return {
    anchor,
    joins,
    alias: key => {
      if (!aliases.has(key)) throw new Error(`No join planned for dataset ${key}`);
      return aliases.get(key);
    },
  };
}
