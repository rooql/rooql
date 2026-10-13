# RooQL

**A tiny semantic layer you ship with your app.**

RooQL compiles metric queries into SQL from an [Apache Ossie](https://github.com/apache/ossie) semantic model. It runs inside your app (a browser, a Claude artifact, a Node script), so there is no semantic server to deploy. Define `revenue` once in the model, and every app that compiles from it gets the same number.

- About 16 KB gzipped, no runtime dependencies
- Compiles to Snowflake, DuckDB and BigQuery SQL
- Refuses queries it can't answer correctly, with a typed error, rather than returning a plausible wrong number

Try it in your browser at [rooql.com/play](https://rooql.com/play).

## Quick start

```sh
git clone https://github.com/rooql/rooql.git
cd rooql
npm install
npm test
npm run example:duckdb
```

The DuckDB example loads a small orders table and an Ossie model, compiles a few queries and runs them in memory. Pass your own query as JSON:

```sh
npm run example:duckdb -- '{"metrics":["net_revenue"],"dimensions":["orders.channel"]}'
```

Edit `examples/duckdb/model.json` (change what `net_revenue` means, say) and run the same query again to see the new definition used.

## Usage

```js
import { loadOssieModel, createRooql } from "./src/index.js";

const model = await loadOssieModel(jsonText); // the Ossie model as JSON text
const rooql = createRooql({ model, dialect: "duckdb" }); // or "snowflake", "bigquery"

const { sql, columns } = rooql.compile({
  metrics: ["revenue"],
  dimensions: ["customers.segment", { field: "orders.created_at", grain: "month" }],
  filters: [{ field: "orders.status", operator: "eq", value: "completed" }],
  orderBy: [{ field: "revenue", direction: "desc" }],
  limit: 20,
});

const rows = await yourWarehouse.query(sql);
```

RooQL only writes SQL. Your app runs it through whatever connection it already has, so warehouse permissions still decide who sees what.

`columns` maps the generated column aliases back to metric and field names. `compile()` also returns `modelHash`, so you can show which version of the model produced a number. `rooql.catalog()` lists the metrics and fields a model exposes.

For the browser, `npm run build` writes `dist/rooql.js` (ES module) and `dist/rooql.iife.js` (a script that defines a global `rooql`).

## What it supports

- **Models:** Ossie `0.2.0.dev0` JSON with several datasets and relationships, computed fields, and metrics built from other metrics.
- **Expressions:** arithmetic, comparisons, `CASE`, `CAST`, a fixed catalogue of conditional, maths, string and date functions, and the usual aggregates (`SUM`, `COUNT`, `COUNT(DISTINCT)`, `AVG`, `MIN`, `MAX`, `MEDIAN`, `STDDEV`…).
- **Queries:** metrics, dimensions with time grains (`year` down to `minute`), filters, `having`, `orderBy` and `limit`.
- **Joins:** star schemas. Each query anchors on one fact table and joins out along many-to-one relationships.

Anything that would give a wrong answer is refused with a typed error instead, for example a join that would double-count (`FANOUT_UNSAFE`) or metrics from two fact tables in one query (`MULTI_FACT_UNSUPPORTED`).

## Tests

`npm test` needs Node 24 or newer. The tests run the generated SQL in DuckDB and compare the results with hand-written SQL. They also load every model in the Apache Ossie repository.

## License

[Apache 2.0](LICENSE)
