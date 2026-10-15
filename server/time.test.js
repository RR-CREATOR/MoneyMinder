const test = require("node:test");
const assert = require("node:assert");
const { dateKey, monthInfo } = require("./time");

test("dateKey uses the configured India calendar at UTC boundaries", () => {
  const instant = new Date("2026-07-31T19:00:00.000Z");
  assert.strictEqual(dateKey(instant), "2026-08-01");
  assert.deepStrictEqual(monthInfo(instant), {
    date: "2026-08-01",
    month: "2026-08",
    day: 1,
    daysInMonth: 31,
  });
});

test("dateKey rejects invalid dates", () => {
  assert.strictEqual(dateKey(new Date("invalid")), "");
});
