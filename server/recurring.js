const crypto = require("crypto");
const db = require("./db");
const { parseMoney } = require("./money");
const { monthInfo } = require("./time");
const { MAX_EXPENSES_PER_HOUSEHOLD, MAX_EXPENSES_PER_USER } = require("./households");

// ponytail: a plain loop on a setInterval, no cron dependency. Idempotent per
// month via lastPostedYM, so re-running (on every boot + every 6h) is safe.

// Is this bill due to post this month? Due once its day-of-month has arrived
// and it hasn't already been posted for the current YYYY-MM.
function dueRecurring(item, now) {
  const local = monthInfo(now);
  if (!item || parseMoney(item.amount) === null) return false;
  if (!Number.isInteger(item.dayOfMonth) || item.dayOfMonth < 1 || item.dayOfMonth > local.day) return false;
  return item.lastPostedYM !== local.month;
}

// Post every due recurring bill across all households as a real expense paid by
// the household owner, then stamp lastPostedYM so it won't post again this month.
async function runOnce(now = new Date()) {
  const { month } = monthInfo(now);
  return db.update((d) => {
    let posted = 0;
    const householdCounts = {};
    const userCounts = {};
    for (const expense of Object.values(d.expenses || {})) {
      householdCounts[expense.householdId] = (householdCounts[expense.householdId] || 0) + 1;
      if (expense.paidBy) userCounts[expense.paidBy] = (userCounts[expense.paidBy] || 0) + 1;
    }
    for (const h of Object.values(d.households || {})) {
      if (!Array.isArray(h.recurring)) continue;
      let expenseCount = householdCounts[h.id] || 0;
      const activeMembers = h.members.filter((member) => Object.hasOwn(d.users || {}, member));
      const paidBy = activeMembers.includes(h.ownerKey) ? h.ownerKey : activeMembers[0];
      if (!paidBy) continue;
      h.ownerKey = paidBy;
      for (const item of h.recurring) {
        if (expenseCount >= MAX_EXPENSES_PER_HOUSEHOLD
            || (userCounts[paidBy] || 0) >= MAX_EXPENSES_PER_USER) break;
        if (!dueRecurring(item, now)) continue;
        const split = Array.isArray(item.splitAmong) && item.splitAmong.length
          ? [...new Set(item.splitAmong.filter((m) => activeMembers.includes(m)))]
          : activeMembers.slice();
        if (!split.length) continue;
        const id = crypto.randomUUID();
        d.expenses[id] = {
          id,
          householdId: h.id,
          paidBy,
          description: String(item.description || "Bill"),
          amount: parseMoney(item.amount),
          category: item.category || "other",
          splitAmong: split,
          date: `${month}-${String(item.dayOfMonth).padStart(2, "0")}`,
          createdAt: now.toISOString(),
          recurringId: item.id,
        };
        item.lastPostedYM = month;
        posted++;
        expenseCount++;
        userCounts[paidBy] = (userCounts[paidBy] || 0) + 1;
      }
    }
    return posted;
  });
}

// Run on boot, then every 6h. Don't let the interval hold the process open.
function start() {
  runOnce().catch((e) => console.error("recurring run failed:", e.message));
  const t = setInterval(() => {
    runOnce().catch((e) => console.error("recurring run failed:", e.message));
  }, 6 * 60 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
}

module.exports = { start, runOnce, dueRecurring };
