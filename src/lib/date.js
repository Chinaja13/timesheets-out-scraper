export function ymdInDenver(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

export function addDaysYmd(ymd, days) {
  // parse ymd as UTC noon to avoid DST issues
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymdInDenver(dt);
}

export function weekdayInDenver(date = new Date()) {
  // 1=Mon..7=Sun
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" })
    .formatToParts(date)
    .find(p => p.type === "weekday").value
    .replace("Mon","1").replace("Tue","2").replace("Wed","3").replace("Thu","4").replace("Fri","5").replace("Sat","6").replace("Sun","7")
  );
}
