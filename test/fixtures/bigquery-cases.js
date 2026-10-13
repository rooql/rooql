// Shared by local SQL assertions and the optional external dialect validation harness.
export const expressions = [
  ['hours', 'MIN(DATEADD(hour, 2, events.d))', 'DATETIME_ADD(CAST(`t0`.`D` AS DATETIME), INTERVAL 2 HOUR)'],
  ['days', 'MIN(DATEADD(day, 2, events.d))', 'DATE_ADD(`t0`.`D`, INTERVAL 2 DAY)'],
  ['months', 'MIN(DATEADD(month, 1, events.dt))', 'DATETIME_ADD(`t0`.`DT`, INTERVAL 1 MONTH)'],
  ['week', "MIN(DATE_TRUNC('week', events.d))", 'DATE_TRUNC(`t0`.`D`, WEEK(MONDAY))'],
  ['week_number', 'MIN(WEEK(events.d))', 'EXTRACT(ISOWEEK FROM `t0`.`D`)'],
  ['year', 'MIN(YEAR(events.d))', 'EXTRACT(YEAR FROM `t0`.`D`)'],
  ['day_of_year', 'MIN(DAYOFYEAR(events.d))', 'EXTRACT(DAYOFYEAR FROM `t0`.`D`)'],
  ['difference', "MIN(DATEDIFF(week, DATE '2026-01-04', DATE '2026-01-05'))", "DATETIME_DIFF(CAST(DATE '2026-01-05' AS DATETIME), CAST(DATE '2026-01-04' AS DATETIME), WEEK(MONDAY))"],
  ['hour_boundary', "MIN(DATEDIFF(hour, TIMESTAMP '2026-01-01 00:59:59', TIMESTAMP '2026-01-01 01:00:00'))", 'DATETIME_DIFF('],
  ['time_add', "MIN(DATEADD(minute, 2, TIME '12:59:00'))", "TIME_ADD(TIME '12:59:00', INTERVAL 2 MINUTE)"],
  ['time_diff', "MIN(DATEDIFF(minute, TIME '12:59:00', TIME '13:01:00'))", "TIME_DIFF(TIME '13:01:00', TIME '12:59:00', MINUTE)"],
  ['contains', "MIN(CONTAINS(events.s, 'b'))", "STRPOS(`t0`.`S`, 'b') > 0"],
  ['prefix', "MIN(STARTSWITH(events.s, 'A'))", "STARTS_WITH(`t0`.`S`, 'A')"],
  ['suffix', "MIN(ENDSWITH(events.s, 'C'))", "ENDS_WITH(`t0`.`S`, 'C')"],
  ['concat', "MIN(CONCAT(events.s, '-', 42))", "CONCAT(CAST(`t0`.`S` AS STRING), CAST('-' AS STRING), CAST(42 AS STRING))"],
  ['null_concat', 'MIN(CONCAT(events.s, NULL))', 'CAST(NULL AS STRING)'],
  ['split', "MIN(SPLIT_PART(events.s, '-', -1))", 'ARRAY_REVERSE(SPLIT('],
  ['split_zero', "MIN(SPLIT_PART(events.s, '-', 0))", 'SAFE_ORDINAL('],
  ['split_missing', "MIN(SPLIT_PART(events.s, '-', 10))", 'SAFE_ORDINAL('],
  ['split_empty_delimiter', "MIN(SPLIT_PART(events.s, '', 1))", '[`t0`.`S`]'],
  ['ilike', "MIN(events.s ILIKE 'a%')", "LOWER(CAST(`t0`.`S` AS STRING)) LIKE LOWER(CAST('a%' AS STRING))"],
  ['null_like', 'MIN(events.s LIKE NULL)', 'OR NULL IS NULL THEN NULL'],
  ['not_like', "MIN(events.s NOT LIKE 'A%')", 'NOT LIKE'],
  ['remainder', 'SUM(events.n % 2)', 'MOD(`t0`.`N`, 2)'],
  ['safe_cast', 'SUM(TRY_CAST(events.s AS INTEGER))', 'SAFE_CAST(`t0`.`S` AS INT64)'],
  ['wall_clock', "MIN(CAST('2026-01-01 12:00:00' AS TIMESTAMP_NTZ))", 'AS DATETIME)'],
  ['string_cast', 'MIN(CAST(events.n AS VARCHAR))', 'AS STRING)'],
  ['conditional', 'SUM(IFF(events.n > 1, events.n, 0))', 'CASE WHEN'],
];

export const document = () => ({
  version: '0.2.0.dev0', name: 'bigquery_cases',
  datasets: [{ name: 'events', source: 'events', fields: Object.entries({
    n: 'Integer', s: 'String', d: 'Date', dt: 'DateTime', tz: 'DateTimeTz', dec: 'Decimal', clock: 'Time',
  }).map(([name, datatype]) => ({ name, expression: name, datatype })) }],
  metrics: expressions.map(([name, expression]) => ({ name, expression })),
});
