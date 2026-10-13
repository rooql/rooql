import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalIdentifier, semanticName } from '../src/identifiers.js';
import { snowflakeLiteral } from '../src/literals.js';

test('physical names preserve quoted case and uppercase unquoted names', () => {
  assert.equal(physicalIdentifier('analytics.public.orders', 3), '"ANALYTICS"."PUBLIC"."ORDERS"');
  assert.equal(physicalIdentifier('"a.b"."quote""name"', 3), '"a.b"."quote""name"');
});

test('physical and semantic names refuse SQL syntax', () => {
  for (const value of ['orders; DROP TABLE x', 'orders -- comment', '(SELECT 1)', 'a.', 'a..b', '"unclosed', 'a.b.c.d', '']) {
    assert.throws(() => physicalIdentifier(value, 3), { code: 'INVALID_IDENTIFIER' });
  }
  assert.throws(() => physicalIdentifier('orders.amount', 1), { code: 'INVALID_IDENTIFIER' });
  assert.throws(() => semanticName('country; SELECT 1'), { code: 'INVALID_NAME' });
});

test('identifier lengths, controls and Unicode boundaries are enforced', () => {
  assert.equal(semanticName('a'.repeat(128)), 'a'.repeat(128));
  assert.throws(() => semanticName('a'.repeat(129)), { code: 'INVALID_NAME' });
  assert.equal(physicalIdentifier(`"${'a'.repeat(255)}"`, 1), `"${'a'.repeat(255)}"`);
  assert.throws(() => physicalIdentifier(`"${'a'.repeat(256)}"`, 1), { code: 'INVALID_IDENTIFIER' });
  for (const value of ['"\ud800"', '"a\u0080b"', '"a\u009fb"', '"a\u0000b"']) {
    assert.throws(() => physicalIdentifier(value, 1), { code: 'INVALID_IDENTIFIER' });
  }
});

test('Snowflake strings escape literal backslashes before quotes and controls', () => {
  assert.equal(snowflakeLiteral("O'Brien\\n\n\u0000\t$$", 'String'), "'O''Brien\\\\n\\u000a\\u0000\\u0009$$'");
  assert.equal(snowflakeLiteral("x\\'; DROP TABLE orders;--", 'String'), "'x\\\\''; DROP TABLE orders;--'");
  assert.equal(snowflakeLiteral('😀', 'String'), "'😀'");
  assert.throws(() => snowflakeLiteral('\ud800', 'String'), { code: 'INVALID_FILTER_VALUE' });
});

test('numeric filters accept safe integers and refuse coercion or precision loss', () => {
  assert.equal(snowflakeLiteral(-42, 'Decimal'), '-42');
  for (const value of ['42', 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null, true]) {
    assert.throws(() => snowflakeLiteral(value, 'Integer'), { code: 'INVALID_FILTER_VALUE' });
  }
});
