const FULL_DAY_HOURS = 7.99;

function fmtHours(n) {
  const r = Math.round((Number(n) || 0) * 100) / 100;
  let s = String(r);
  if (s.includes(".")) {
    while (s.endsWith("0")) s = s.slice(0, -1);
    if (s.endsWith(".")) s = s.slice(0, -1);
  }
  return s;
}

function joinClauses(clauses) {
  if (!clauses.length) return "";
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]}, and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

export function buildTier2Daily(outList) {
  const parts = outList.map(p => {
    if ((p.hours || 0) >= FULL_DAY_HOURS) return `${p.name} is out today`;
    return `${p.name} is out ${fmtHours(p.hours)} hours today`;
  });
  return `@channel ${joinClauses(parts)}.`;
}

export function buildLeadsDayBlock(label, outList) {
  if (!outList.length) return `${label}\nNo one out`;
  const lines = outList.map(p => `${p.name} — ${fmtHours(p.hours)}h (${p.type || "Out"})`);
  return `${label}\n${lines.join("\n")}`;
}

export function sortOutList(outList) {
  return outList.slice().sort((a, b) => {
    const af = (a.hours || 0) >= FULL_DAY_HOURS ? 1 : 0;
    const bf = (b.hours || 0) >= FULL_DAY_HOURS ? 1 : 0;
    if (af !== bf) return bf - af;
    if ((b.hours || 0) !== (a.hours || 0)) return (b.hours || 0) - (a.hours || 0);
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}
