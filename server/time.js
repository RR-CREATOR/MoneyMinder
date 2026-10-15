const TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Kolkata";
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthInfo(date = new Date()) {
  const key = dateKey(date);
  if (!key) return { date: "", month: "", day: 0, daysInMonth: 0 };
  const [year, month, day] = key.split("-").map(Number);
  return {
    date: key,
    month: key.slice(0, 7),
    day,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

function isDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

module.exports = { TIME_ZONE, dateKey, monthInfo, isDateKey };
