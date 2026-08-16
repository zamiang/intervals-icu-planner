import type { Activity, FtpSyncConfig } from "./types.js";
import type { RideSportSettings } from "./intervals.js";

// eFTP sync: Intervals.icu stamps every activity with `icu_rolling_ftp` — its
// rolling FTP estimate from best efforts in the trailing window. That estimate
// tracks a formal test closely (unlike the per-ride power-model `icu_pm_ftp`,
// which swings wildly with how hard the single ride was), so it's the value we
// mirror into the Ride sport-settings FTP. Sport-settings FTP is what
// Intervals.icu resolves `% FTP` workout steps against, so applying eFTP there
// makes every structured target and rendered watt callout track fitness
// automatically.

// Most recent eFTP across the fetched activities. Entries without one (weight
// sessions, walks, unset accounts report 0/null) are skipped.
export function latestEftp(activities: Activity[]): number | undefined {
  const withEftp = activities
    .filter((a) => typeof a.icu_rolling_ftp === "number" && a.icu_rolling_ftp > 0)
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));
  const latest = withEftp[withEftp.length - 1];
  return latest ? (latest.icu_rolling_ftp as number) : undefined;
}

export type FtpSyncDecision =
  { action: "apply"; target: number } | { action: "skip"; reason: string };

// Decide whether to write eFTP into the sport settings. Pure so it's testable;
// the caller performs the PUT. `max_change_pct` is a bad-data guard: a single
// implausible jump (corrupt file, power-meter spike) is refused rather than
// silently repacing the whole week — cross it by setting FTP in Intervals.icu
// by hand if the change is real.
export function planFtpSync(
  current: number | null,
  eftp: number | undefined,
  cfg: FtpSyncConfig,
): FtpSyncDecision {
  if (!cfg.enabled) return { action: "skip", reason: "ftp_sync.enabled is false" };
  if (eftp === undefined) {
    return { action: "skip", reason: "no eFTP found on recent activities" };
  }
  const target = Math.round(eftp);
  if (current === null) return { action: "apply", target };
  if (target === current) {
    return { action: "skip", reason: `eFTP ${target}W already matches settings FTP` };
  }
  const changePct = (Math.abs(target - current) / current) * 100;
  if (changePct > cfg.max_change_pct) {
    return {
      action: "skip",
      reason:
        `eFTP ${target}W is ${changePct.toFixed(1)}% away from settings FTP ${current}W ` +
        `(max_change_pct ${cfg.max_change_pct}) — likely bad data; update Intervals.icu manually if real`,
    };
  }
  return { action: "apply", target };
}

export interface RenderTargetValues {
  ftp: number | null;
  lthr: number | null;
}

// Run the eFTP sync against Intervals.icu and return the FTP/LTHR that prose
// placeholders should render with. On apply, the returned FTP is the eFTP —
// also under --dry-run (no write happens, but the preview shows the watts a
// real run would push). Shared by `plan` (cli.ts) and push-week.
export async function syncFtp(
  client: { updateSportSettings(id: number, fields: Record<string, unknown>): Promise<void> },
  settings: RideSportSettings | null,
  activities: Activity[],
  cfg: FtpSyncConfig,
  opts: { dryRun: boolean; log?: (msg: string) => void },
): Promise<RenderTargetValues> {
  const log = opts.log ?? console.log;
  if (!cfg.enabled) return { ftp: settings?.ftp ?? null, lthr: settings?.lthr ?? null };
  if (!settings) {
    log("FTP sync: no Ride sport-settings entry on Intervals.icu — skipped");
    return { ftp: null, lthr: null };
  }
  const decision = planFtpSync(settings.ftp, latestEftp(activities), cfg);
  if (decision.action === "skip") {
    // "Already matches" is the weekly steady state — only surface actionable skips.
    if (!decision.reason.includes("already matches")) log(`FTP sync: ${decision.reason} — skipped`);
    return { ftp: settings.ftp, lthr: settings.lthr };
  }
  const from = settings.ftp !== null ? `${settings.ftp}W` : "unset";
  if (opts.dryRun) {
    log(`FTP sync: would update Intervals.icu FTP ${from} -> ${decision.target}W (eFTP) — dry run`);
  } else {
    await client.updateSportSettings(settings.id, { ftp: decision.target });
    log(`FTP sync: updated Intervals.icu FTP ${from} -> ${decision.target}W (eFTP)`);
  }
  return { ftp: decision.target, lthr: settings.lthr };
}

// Render watt/bpm placeholders in prose descriptions from the live settings, so
// YAML never hardcodes a number that goes stale when FTP changes:
//   {ftp}       -> FTP in watts            {lthr}      -> LTHR in bpm
//   {w:62}      -> watts at 62% FTP        {w:88-94}   -> "207-221" style range
//   {hr:83}     -> bpm at 83% LTHR         {hr:80-90}  -> bpm range
// Throws when a placeholder needs a value Intervals.icu didn't provide — a
// pushed description with literal braces (or stale watts) would be worse than a
// loud failure.
export function renderTargets(text: string, values: RenderTargetValues): string {
  const need = (v: number | null, what: string, placeholder: string): number => {
    if (typeof v !== "number" || v <= 0) {
      throw new Error(
        `Description uses ${placeholder} but no ${what} is available from Intervals.icu sport settings`,
      );
    }
    return v;
  };
  const rendered = text.replace(
    /\{(ftp|lthr)\}|\{(w|hr):(\d+)(?:-(\d+))?\}/g,
    (
      _m,
      plain: string | undefined,
      kind: string | undefined,
      lo: string,
      hi: string | undefined,
    ) => {
      if (plain === "ftp") return String(need(values.ftp, "FTP", "{ftp}"));
      if (plain === "lthr") return String(need(values.lthr, "LTHR", "{lthr}"));
      const base =
        kind === "w"
          ? need(values.ftp, "FTP", `{w:${lo}}`)
          : need(values.lthr, "LTHR", `{hr:${lo}}`);
      const at = (pct: string) => String(Math.round((base * Number(pct)) / 100));
      return hi !== undefined ? `${at(lo)}-${at(hi)}` : at(lo);
    },
  );
  // A placeholder the regex didn't consume (e.g. {w:abc}, {w:62%}, {ftp:50}) is
  // a typo in the YAML — surface it instead of pushing literal braces to the
  // calendar. Any brace form starting with a known keyword counts, whatever the
  // suffix: the substitution pass consumed every well-formed one already.
  const leftover = rendered.match(/\{(?:ftp|lthr|w|hr)(?::[^}]*)?\}/);
  if (leftover) {
    throw new Error(
      `Malformed target placeholder ${leftover[0]} — use {ftp}, {lthr}, {w:NN[-MM]}, {hr:NN[-MM]}`,
    );
  }
  return rendered;
}
