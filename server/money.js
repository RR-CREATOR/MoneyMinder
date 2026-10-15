const MAX_MONEY_PAISE = 1_000_000_000; // ₹1 crore per amount

function parseMoney(value, { allowZero = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (raw.length > 11 || !/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(MAX_MONEY_PAISE) || paise < BigInt(allowZero ? 0 : 1)) return null;
  return Number(paise) / 100;
}

function toPaise(value) {
  const amount = parseMoney(value, { allowZero: true });
  return amount === null ? null : Math.round(amount * 100);
}

function addPaise(left, right) {
  const total = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(total)) {
    throw new RangeError("Money aggregate must remain a safe integer");
  }
  return total;
}

function allocatePaise(value, members, paidBy) {
  const total = toPaise(value);
  const split = Array.isArray(members) ? [...new Set(members)] : [];
  if (total === null || !split.length) return null;
  const order = [...split.filter((member) => member !== paidBy), ...split.filter((member) => member === paidBy)];
  const base = Math.floor(total / order.length);
  let remainder = total % order.length;
  return Object.fromEntries(order.map((member) => {
    const share = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return [member, share];
  }));
}

module.exports = {
  MAX_MONEY_PAISE,
  addPaise,
  allocatePaise,
  parseMoney,
  toPaise,
};
