// One-off training-volume review: pulls recent activities + wellness from
// Intervals.icu and summarizes weekly volume, intensity mix, and CTL ramp.
// Usage: npx tsx scripts/weekly-review.ts [weeks]   (default 8)
import "dotenv/config";
import { IntervalsClient } from "../src/intervals.js";

const WEEKS = Number(process.argv[2] ?? 8);
const apiKey = process.env.INTERVALS_API_KEY;
if (!apiKey) throw new Error("INTERVALS_API_KEY not set");

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const start = new Date(today);
start.setDate(start.getDate() - WEEKS * 7 - 7); // pad a week for ramp context

const client = new IntervalsClient(apiKey);

// Raw activities fetch (need moving_time, which the typed client drops).
const res = await fetch(
  `https://intervals.icu/api/v1/athlete/0/activities?oldest=${fmt(start)}&newest=${fmt(today)}`,
  { headers: { Authorization: `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}` } },
);
const acts = (await res.json()) as Array<Record<string, unknown>>;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const wellness = await client.getTrainingLoadRange(fmt(start), fmt(today));

// ISO week key (Mon-anchored).
function weekKey(dateStr: string): string {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return fmt(d);
}

type Wk = {
  tss: number;
  hours: number;
  rides: number;
  weights: number;
  z12s: number; // seconds in Z1+Z2 (easy)
  hards: number; // seconds in Z3+ (moderate/hard)
  longRide: number; // longest single ride, hours
  byType: Record<string, number>;
};
const weeks = new Map<string, Wk>();
const wk = (k: string): Wk =>
  weeks.get(k) ??
  (weeks.set(k, {
    tss: 0,
    hours: 0,
    rides: 0,
    weights: 0,
    z12s: 0,
    hards: 0,
    longRide: 0,
    byType: {},
  }),
  weeks.get(k)!);

for (const a of acts) {
  const k = weekKey(str(a.start_date_local ?? a.start_date, ""));
  if (!k) continue;
  const w = wk(k);
  const tss = num(a.icu_training_load);
  const secs = num(a.moving_time);
  const type = str(a.type, "Other");
  w.tss += tss;
  w.hours += secs / 3600;
  w.byType[type] = (w.byType[type] ?? 0) + tss;
  if (/ride/i.test(type)) {
    w.rides++;
    w.longRide = Math.max(w.longRide, secs / 3600);
  }
  if (/weight/i.test(type)) w.weights++;
  const zt = a.icu_zone_times;
  if (Array.isArray(zt) && zt.length) {
    // zone_times: [z1, z2, z3, z4, z5, ...] seconds, or [{secs}, ...]
    const nums = zt.map((z: unknown) =>
      typeof z === "number" ? z : num((z as { secs?: number })?.secs),
    );
    w.z12s += (nums[0] ?? 0) + (nums[1] ?? 0);
    w.hards += nums.slice(2).reduce((s: number, n: number) => s + n, 0);
  }
}

// End-of-week CTL (last wellness entry on/before each Sunday).
const ctlByDate = new Map(wellness.map((w) => [w.date, w.ctl]));
function ctlAt(weekStart: string): number {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + 6); // Sunday
  for (let i = 0; i < 7; i++) {
    const key = fmt(d);
    if (ctlByDate.has(key)) return ctlByDate.get(key)!;
    d.setDate(d.getDate() - 1);
  }
  return 0;
}

const keys = [...weeks.keys()].sort();
console.log(
  `\nWeekly training review — last ${WEEKS} weeks (${keys[0]} → ${keys[keys.length - 1]})\n`,
);
console.log("week start   TSS   hrs  rides  wt   easy%  long   CTL  ramp   mix (TSS by type)");
console.log("─".repeat(92));
let prevCtl = 0;
for (const k of keys) {
  const w = weeks.get(k)!;
  const zoneTotal = w.z12s + w.hards;
  const easyPct = zoneTotal ? Math.round((w.z12s / zoneTotal) * 100) : NaN;
  const ctl = ctlAt(k);
  const ramp = prevCtl ? ctl - prevCtl : 0;
  prevCtl = ctl;
  const mix = Object.entries(w.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `${t} ${Math.round(v)}`)
    .join(", ");
  console.log(
    `${k}  ${String(Math.round(w.tss)).padStart(4)}  ${w.hours.toFixed(1).padStart(4)}   ${String(w.rides).padStart(2)}   ${String(w.weights).padStart(2)}   ${(isNaN(easyPct) ? "  —" : easyPct + "%").padStart(4)}  ${w.longRide.toFixed(1).padStart(4)}  ${ctl ? ctl.toFixed(1).padStart(5) : "    —"}  ${(ramp >= 0 ? "+" : "") + ramp.toFixed(1)}   ${mix}`,
  );
}
console.log("");
