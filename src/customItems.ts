// Declarative definitions of the Intervals.icu custom items (fitness charts and
// computed activity fields) this setup depends on, plus the pure sync-planning
// logic. The definitions here are the source of truth; scripts/sync-custom-items.ts
// pushes them to the account so the setup is reproducible instead of living only
// as hand-made items in the web UI.
//
// Item types (Intervals.icu "custom items"):
//   FITNESS_CHART  — a chart on the /fitness page (plots per-activity fields
//                    over time, with filters and moving averages)
//   ACTIVITY_FIELD — a computed field: its script runs server-side when an
//                    activity is analyzed and the last expression is stored on
//                    the activity under `code`

export interface CustomItemDef {
  type: "FITNESS_CHART" | "ACTIVITY_FIELD";
  name: string;
  description: string;
  content: Record<string, unknown>;
}

// The subset of a custom item as returned by GET /athlete/{id}/custom-item that
// the sync planner needs.
export interface RemoteCustomItem {
  id: number;
  type: string;
  name: string;
  description?: string | null;
  content?: unknown;
}

export interface SyncPlan {
  create: CustomItemDef[];
  update: { id: number; def: CustomItemDef }[];
  unchanged: { id: number; def: CustomItemDef }[];
}

// Ride types the fitness-chart plots filter to (matches the account's existing
// "Ride FTP" chart so all ride charts agree on what counts as a ride).
const RIDE_TYPES = ["Ride", "VirtualRide", "MountainBikeRide", "GravelRide"];

interface PlotOpts {
  agg?: string;
  aggDays?: number;
}

// One plot in a FITNESS_CHART, shaped exactly like the objects the web UI
// saves (captured from existing items via the API). `filter` here is the
// number-format filter (e.g. "dec2"), not the activity filter — that's
// `filters`.
function plot(
  id: number,
  field: string,
  text: string,
  title: string,
  scale: string,
  type: "line" | "dot",
  fill: string,
  stroke: string,
  numberFilter: string,
  opts: PlotOpts = {},
): Record<string, unknown> {
  return {
    id,
    agg: opts.agg ?? "none",
    band: 0,
    fill,
    text,
    type,
    field,
    scale,
    stack: "",
    title,
    extras: [],
    filter: numberFilter,
    radius: 3,
    stroke,
    ...(opts.aggDays ? { aggArgs: { days: opts.aggDays, factor: 1 } } : {}),
    filters: [{ id: 1, value: RIDE_TYPES, field_id: "type" }],
    markerValue: "right-inline",
    strokeWidth: 1,
    showOnCalendar: false,
    invertSubWellness: false,
  };
}

function fitnessChart(
  contentId: string,
  name: string,
  description: string,
  yAxisLabel: string,
  plots: Record<string, unknown>[],
): CustomItemDef {
  return {
    type: "FITNESS_CHART",
    name,
    description,
    content: {
      id: contentId,
      name,
      plots,
      title: null,
      height: 150,
      yAxisMax: null,
      yAxisMin: null,
      y2AxisMax: null,
      y2AxisMin: null,
      yAxisLabel,
      y2AxisLabel: null,
      stackTo100Percent: null,
    },
  };
}

// Computed activity-field scripts. These run in Intervals.icu's server-side
// sandbox at analysis time: `icu.streams.<name>` are plain per-second arrays
// and the script's last expression is the stored value. Guards: >= 2400
// samples (~40 min) so half-vs-half comparisons mean something, and > 300
// valid samples per half so a mostly-null stream can't produce a value from
// a handful of readings. Missing streams throw on access — the try/catch
// turns that into "no value" rather than an analysis error.
const TEMP_DRIFT_SCRIPT = `{
  let v = null
  try {
    let t = icu.streams.temp
    if (t && t.length >= 2400) {
      let n = t.length, h = n >> 1, s1 = 0, c1 = 0, s2 = 0, c2 = 0
      for (let i = 0; i < h; i++) if (t[i] != null) { s1 += t[i]; c1++ }
      for (let i = h; i < n; i++) if (t[i] != null) { s2 += t[i]; c2++ }
      if (c1 > 300 && c2 > 300) v = s2 / c2 - s1 / c1
    }
  } catch (e) {}
  v
}`;

// Tymewear gate shared by the breathing scripts. The Edge 840 also writes a
// `respiration` stream on rides without the strap — its own breathing-rate
// estimate from the HR strap, smooth 5-second steps — so `respiration` alone
// does not mean Tymewear. Only the strap records `tidal_volume`, and only a
// tidal-volume stream that actually moves counts: on a dropout the strap
// flatlines at one value for the whole ride (seen Nov 30–Dec 7 2025), which
// would read as a perfectly steady breath. Leaves `tv` null when the gate fails.
const TYMEWEAR_GATE = `let tv = icu.streams.tidal_volume
    let live = 0
    if (tv) for (let i = 1; i < tv.length; i++) if (tv[i] > 0 && tv[i] != tv[i - 1]) live++
    if (live < 300) tv = null`;

const RESP_DRIFT_SCRIPT = `{
  let v = null
  try {
    let r = icu.streams.respiration
    ${TYMEWEAR_GATE}
    if (tv && r && r.length >= 2400) {
      let n = r.length, h = n >> 1, s1 = 0, c1 = 0, s2 = 0, c2 = 0
      for (let i = 0; i < h; i++) if (r[i] != null && r[i] > 0) { s1 += r[i]; c1++ }
      for (let i = h; i < n; i++) if (r[i] != null && r[i] > 0) { s2 += r[i]; c2++ }
      if (c1 > 300 && c2 > 300) v = (s2 / c2 / (s1 / c1) - 1) * 100
    }
  } catch (e) {}
  v
}`;

// Power:ventilation decoupling. Ventilation (VE) is breathing rate × tidal
// volume — the quantity the strap is validated for and what tracks metabolic
// cost. Breathing rate alone rises with heat and arousal without any change in
// work, so it is the noisier half of the pair.
const RESP_DECOUPLING_SCRIPT = `{
  let v = null
  try {
    let r = icu.streams.respiration
    let w = icu.streams.fixed_watts
    ${TYMEWEAR_GATE}
    if (tv && r && w && r.length >= 2400 && w.length == r.length && tv.length == r.length) {
      let n = r.length, h = n >> 1
      let es1 = 0, ws1 = 0, c1 = 0, es2 = 0, ws2 = 0, c2 = 0
      for (let i = 0; i < h; i++) if (r[i] > 0 && tv[i] > 0 && w[i] != null) { es1 += r[i] * tv[i]; ws1 += w[i]; c1++ }
      for (let i = h; i < n; i++) if (r[i] > 0 && tv[i] > 0 && w[i] != null) { es2 += r[i] * tv[i]; ws2 += w[i]; c2++ }
      if (c1 > 300 && c2 > 300 && es1 > 0 && es2 > 0) {
        let ef1 = ws1 / es1
        let ef2 = ws2 / es2
        if (ef2 > 0) v = (ef1 / ef2 - 1) * 100
      }
    }
  } catch (e) {}
  v
}`;

// Ventilatory efficiency: watts per unit of ventilation while riding steadily
// in the endurance band (55–75% FTP on a 30 s rolling average), skipping the
// first 10 minutes so warm-up and VE on-kinetics don't count. Lower = more air
// for the same work, which on an easy ride means tired legs recruiting extra
// (carb-burning, CO2-heavy) fibres — the fatigue signal readiness.ts reads.
// Needs 20+ minutes in the band: below that the per-ride spread roughly
// doubles (backtested on 2025-10..2026-09 rides). Scaled ×1000 into a
// readable range; the strap's tidal-volume units are uncalibrated, so the
// value is an index to compare against itself, not a physiological quantity.
const VENT_EFF_SCRIPT = `{
  let v = null
  try {
    let r = icu.streams.respiration
    let w = icu.streams.fixed_watts
    ${TYMEWEAR_GATE}
    let ftp = icu.activity.icu_ftp
    if (tv && r && w && ftp > 0 && w.length == r.length && tv.length == r.length) {
      let lo = 0.55 * ftp, hi = 0.75 * ftp, roll = 0, ws = 0, es = 0, c = 0
      for (let i = 0; i < w.length; i++) {
        roll += w[i] || 0
        if (i >= 30) roll -= w[i - 30] || 0
        if (i < 600) continue
        let p = roll / 30
        if (p >= lo && p <= hi && w[i] != null && r[i] > 0 && tv[i] > 0) { ws += w[i]; es += r[i] * tv[i]; c++ }
      }
      if (c >= 1200 && es > 0) v = (ws / es) * 1000
    }
  } catch (e) {}
  v
}`;

function activityField(
  code: string,
  name: string,
  description: string,
  units: string,
  color: string,
  script: string,
): CustomItemDef {
  return {
    type: "ACTIVITY_FIELD",
    name,
    description,
    content: {
      max: null,
      min: null,
      code,
      icon: null,
      link: null,
      name,
      type: "numeric",
      color,
      units,
      inline: true,
      prefix: null,
      script,
      suffix: null,
      example: null,
      options: null,
      aggregate: "AVERAGE",
      pace_units: null,
      number_format: ".1f",
      fit_session_field: null,
    },
  };
}

export const CUSTOM_ITEM_DEFS: CustomItemDef[] = [
  fitnessChart(
    "phz2ae01",
    "Aerobic Efficiency (Power:HR Z2)",
    "42-day moving average of average power / average HR while in HR Z2, rides only. " +
      "Rising = aerobic base improving. Note: Assioma Duo + saddle change on 2026-07-25 — " +
      "compare post-7/25 rides against each other.",
    "Power/HR Z2",
    [
      plot(
        1,
        "power_hr_z2",
        "Power/HR Z2",
        "Avg power / HR in HR Z2",
        "efficiency",
        "dot",
        "rgba(51,76,204, 0.4)",
        "rgb(51,76,204)",
        "dec2",
      ),
      plot(
        2,
        "power_hr_z2",
        "42d avg",
        "Power/HR Z2 42d moving avg",
        "efficiency",
        "line",
        "rgba(51,76,204, 0.4)",
        "rgb(51,76,204)",
        "dec2",
        { agg: "moving_avg", aggDays: 42 },
      ),
    ],
  ),
  fitnessChart(
    "decpl001",
    "Decoupling (Rides)",
    "Power:HR decoupling per ride (1st half vs 2nd half) with 42-day trend. " +
      "Under 5% on steady endurance rides = good aerobic durability.",
    "Decoupling %",
    [
      plot(
        1,
        "decoupling",
        "Decoupling",
        "Power / HR 1st half vs 2nd",
        "decoupling",
        "dot",
        "rgba(255,82,14, 0.4)",
        "rgb(255,82,14)",
        "dec1_percent_suffix",
      ),
      plot(
        2,
        "decoupling",
        "42d avg",
        "Decoupling 42d moving avg",
        "decoupling",
        "line",
        "rgba(255,82,14, 0.4)",
        "rgb(255,82,14)",
        "dec1_percent_suffix",
        { agg: "moving_avg", aggDays: 42 },
      ),
    ],
  ),
  fitnessChart(
    "lrbal001",
    "L/R Balance (Rides)",
    "Left/right power balance per ride with 28-day trend. Shim evaluation: pre-shim " +
      "baseline 45.9% left (shim added 2026-06-17). Assioma Duo bilateral data starts " +
      "2026-07-25 — earlier values are estimated, don't trend across that boundary.",
    "L/R %",
    [
      plot(
        1,
        "lr_balance",
        "L/R Balance",
        "L/R Power Balance",
        "percent",
        "dot",
        "rgba(0,158,0, 0.4)",
        "rgb(0,158,0)",
        "lr_balance",
      ),
      plot(
        2,
        "lr_balance",
        "28d avg",
        "L/R balance 28d moving avg",
        "percent",
        "line",
        "rgba(0,158,0, 0.4)",
        "rgb(0,100,0)",
        "lr_balance",
        { agg: "moving_avg", aggDays: 28 },
      ),
    ],
  ),
  fitnessChart(
    "venteff1",
    "Ventilatory Efficiency (Rides)",
    "Vent Efficiency per Tymewear ride with 28-day trend. A sustained drop at the same " +
      "endurance power = accumulated fatigue. Strap scale shifted ~2026-07-30 — don't trend " +
      "across that boundary.",
    "W / VE",
    [
      plot(
        1,
        "VentEff",
        "Vent Eff",
        "Endurance-band watts per unit ventilation",
        "efficiency",
        "dot",
        "rgba(23,190,207, 0.4)",
        "rgb(23,190,207)",
        "dec1",
      ),
      plot(
        2,
        "VentEff",
        "28d avg",
        "Vent Eff 28d moving avg",
        "efficiency",
        "line",
        "rgba(23,190,207, 0.4)",
        "rgb(15,130,145)",
        "dec1",
        { agg: "moving_avg", aggDays: 28 },
      ),
    ],
  ),
  activityField(
    "TempDrift",
    "Temp Drift",
    "Device temperature: 2nd-half average minus 1st-half average (deg C). Positive = " +
      "ride got hotter. Only computed for rides over 40 min with a temp stream.",
    "°C",
    "#ff7f0e",
    TEMP_DRIFT_SCRIPT,
  ),
  activityField(
    "RespDrift",
    "Resp Drift",
    "Respiration rate drift: 2nd-half avg vs 1st-half avg (%). Flat respiration + big HR " +
      "decoupling = thermal/cardiovascular drift, not metabolic. Tymewear rides over 40 min " +
      "only (needs a live tidal_volume stream — the Edge's HR-derived breathing rate is ignored).",
    "%",
    "#334ccc",
    RESP_DRIFT_SCRIPT,
  ),
  activityField(
    "RespDecoupling",
    "Resp Decoupling",
    "Power:ventilation decoupling, computed like power:HR decoupling but with minute " +
      "ventilation (breathing rate × tidal volume, %). Heat-independent aerobic durability " +
      "signal. Tymewear rides over 40 min only. Values before 2026-10 used breathing rate alone.",
    "%",
    "#d62728",
    RESP_DECOUPLING_SCRIPT,
  ),
  activityField(
    "VentEff",
    "Vent Efficiency",
    "Watts per unit of minute ventilation in the endurance band (55-75% FTP, after the first " +
      "10 min; needs 20+ min there). Lower = more breathing for the same work — a fatigue " +
      "signal the planner's readiness check reads. Index only (strap units are uncalibrated): " +
      "the strap's scale shifted ~2026-07-30, so compare later rides against each other.",
    "idx",
    "#17becf",
    VENT_EFF_SCRIPT,
  ),
];

// True when every key/element present in `expected` deep-equals the
// corresponding part of `actual`. Extra keys in `actual` are ignored — the
// server decorates saved content with fields we don't set (i18n keys, indexes,
// etc.), and those must not read as drift. Arrays compare element-wise and
// must match in length: a plots array with an extra or missing plot IS drift.
export function deepSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => deepSubset(e, actual[i]));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => deepSubset(v, a[k]));
}

// Match definitions to what's on the account (by type + name) and decide, per
// definition, whether it needs creating, updating, or nothing. Items on the
// account that aren't defined here are left alone — the account is allowed to
// have hand-made items; this sync only owns the ones it defines.
export function planSync(defs: CustomItemDef[], existing: RemoteCustomItem[]): SyncPlan {
  const plan: SyncPlan = { create: [], update: [], unchanged: [] };
  for (const def of defs) {
    const match = existing.find((e) => e.type === def.type && e.name === def.name);
    if (!match) {
      plan.create.push(def);
    } else if (
      deepSubset(def.content, match.content) &&
      (match.description ?? "") === def.description
    ) {
      plan.unchanged.push({ id: match.id, def });
    } else {
      plan.update.push({ id: match.id, def });
    }
  }
  return plan;
}
