export function makeSupportSetFromEnv() {
  const raw = (process.env.SUPPORT_TEAM_NAMES || "").trim();
  if (!raw) return null;
  const names = raw.split(",").map(s => s.trim()).filter(Boolean);
  const set = new Set(names.map(n => normalizeName(n)));
  return set;
}

export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSupportName(name, supportSet) {
  if (!supportSet) return true; // no filter = allow all
  return supportSet.has(normalizeName(name));
}
