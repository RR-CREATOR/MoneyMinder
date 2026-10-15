const test = require("node:test");
const assert = require("node:assert");
const {
  MAX_MONEY_PAISE,
  addPaise,
  allocatePaise,
  parseMoney,
  toPaise,
} = require("./money");

test("parseMoney accepts ordinary two-decimal values and rejects ambiguous inputs", () => {
  assert.strictEqual(parseMoney("12.34"), 12.34);
  assert.strictEqual(parseMoney(12), 12);
  assert.strictEqual(parseMoney("0", { allowZero: true }), 0);
  for (const value of ["1e3", "1.001", "-1", "", true, null, Number.MAX_VALUE]) {
    assert.strictEqual(parseMoney(value), null);
  }
  assert.strictEqual(parseMoney(0), null);
});

test("toPaise converts validated stored money to a safe integer", () => {
  assert.strictEqual(toPaise(12.34), 1234);
  assert.strictEqual(toPaise("0.01"), 1);
  assert.strictEqual(toPaise("1.001"), null);
});

test("money parsing has an exact realistic ceiling and never rounds oversized input", () => {
  assert.strictEqual(parseMoney("10000000.00"), MAX_MONEY_PAISE / 100);
  assert.strictEqual(parseMoney("10000000.01"), null);
  assert.strictEqual(parseMoney("45035996273704.95"), null);
});

test("paise allocation conserves uneven splits and aggregate addition rejects overflow", () => {
  assert.deepStrictEqual(
    allocatePaise("1.00", ["a", "b", "c"], "a"),
    { b: 34, c: 33, a: 33 },
  );
  assert.strictEqual(addPaise(100, -40), 60);
  assert.throws(() => addPaise(Number.MAX_SAFE_INTEGER, 1), /safe integer/);
});
