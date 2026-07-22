import type { Activity, IntervalsEvent, TrainingLoad, WellnessEntry } from "./types.js";

const BASE_URL = "https://intervals.icu/api/v1";
// "0" is Intervals.icu's convention for the authenticated user — resolves to
// whoever owns the API key.
const ATHLETE_ID = "0";

type FetchFn = typeof globalThis.fetch;

function parseWellnessEntry(raw: unknown): TrainingLoad {
  if (!raw || typeof raw !== "object") {
    return { ctl: 0, atl: 0, tsb: 0 };
  }
  const e = raw as Record<string, unknown>;
  const ctl = typeof e.ctl === "number" ? e.ctl : 0;
  const atl = typeof e.atl === "number" ? e.atl : 0;
  return {
    ctl,
    atl,
    tsb: typeof e.tsb === "number" ? e.tsb : ctl - atl,
  };
}

function parseEvent(raw: unknown): IntervalsEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.start_date_local !== "string" || e.start_date_local === "") return null;
  return {
    ...(typeof e.id === "number" ? { id: e.id } : {}),
    start_date_local: e.start_date_local,
    ...(typeof e.end_date_local === "string" ? { end_date_local: e.end_date_local } : {}),
    name: typeof e.name === "string" ? e.name : "",
    ...(typeof e.category === "string" ? { category: e.category } : {}),
    ...(typeof e.description === "string" ? { description: e.description } : {}),
    ...(typeof e.type === "string" ? { type: e.type } : {}),
    ...(typeof e.icu_training_load === "number" ? { icu_training_load: e.icu_training_load } : {}),
    ...(typeof e.moving_time === "number" ? { moving_time: e.moving_time } : {}),
    ...(typeof e.icu_intensity === "number" ? { icu_intensity: e.icu_intensity } : {}),
  };
}

// Activities report icu_intensity as a percentage (e.g. 89.3) while planned
// events use a fraction. No real IF fraction exceeds ~2, so values above 3 can
// only be percentages.
function normalizeIntensity(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw > 3 ? raw / 100 : raw;
}

// icu_zone_times arrives either as a plain seconds array ([z1, z2, ...]) or as
// an array of {id, secs} objects ({id: "Z1"} .. {id: "Z7"}, plus an {id: "SS"}
// sweet-spot bucket that overlaps Z3/Z4 and must not be folded into the Z1..Z7
// array). Normalize both to a 7-element Z1..Z7 seconds array, with SS separate.
function normalizeZoneTimes(raw: unknown): {
  zoneTimes: number[] | null;
  ssTime: number | null;
} {
  if (!Array.isArray(raw) || raw.length === 0) return { zoneTimes: null, ssTime: null };

  if (raw.every((t) => typeof t === "number")) {
    const zoneTimes = Array.from({ length: 7 }, (_, i) => (raw[i] as number) ?? 0);
    return { zoneTimes, ssTime: null };
  }

  const zoneTimes = new Array<number>(7).fill(0);
  let ssTime: number | null = null;
  let sawZone = false;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const secs = typeof e.secs === "number" && Number.isFinite(e.secs) ? e.secs : 0;
    if (id === "SS") {
      ssTime = secs;
      continue;
    }
    const m = /^Z([1-7])$/.exec(id);
    if (m) {
      zoneTimes[Number(m[1]) - 1] = secs;
      sawZone = true;
    }
  }
  return { zoneTimes: sawZone ? zoneTimes : null, ssTime };
}

// The Ride entry of /athlete/{id}/sport-settings, reduced to the fields the
// planner uses. `id` is needed to write the entry back (eFTP sync).
export interface RideSportSettings {
  id: number;
  ftp: number | null;
  lthr: number | null;
}

export class IntervalsClient {
  private headers: Record<string, string>;
  private fetch: FetchFn;

  constructor(apiKey: string, fetchFn: FetchFn = globalThis.fetch) {
    const encoded = Buffer.from(`API_KEY:${apiKey}`).toString("base64");
    this.headers = {
      Authorization: `Basic ${encoded}`,
      "Content-Type": "application/json",
    };
    this.fetch = fetchFn;
  }

  async getEvents(oldest: string, newest: string): Promise<IntervalsEvent[]> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/events?oldest=${oldest}&newest=${newest}`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(parseEvent).filter((e): e is IntervalsEvent => e !== null);
  }

  async getTrainingLoadRange(oldest: string, newest: string): Promise<WellnessEntry[]> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/wellness?oldest=${oldest}&newest=${newest}`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((entry) => {
      const load = parseWellnessEntry(entry);
      const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const date = typeof e.id === "string" ? e.id : "";
      return {
        date,
        ...load,
        ...(typeof e.hrvSDNN === "number" ? { hrvSDNN: e.hrvSDNN } : {}),
        ...(typeof e.restingHR === "number" ? { restingHR: e.restingHR } : {}),
      };
    });
  }

  async getTrainingLoad(date: string): Promise<TrainingLoad> {
    const range = await this.getTrainingLoadRange(date, date);
    if (range.length === 0) return { ctl: 0, atl: 0, tsb: 0 };
    const { ctl, atl, tsb } = range[0];
    return { ctl, atl, tsb };
  }

  // Cycling sport settings from Intervals.icu. The endpoint returns one
  // settings object per sport group; we read the one whose `types` includes
  // "Ride". Its FTP is what actually paces the structured `% FTP` workouts
  // (Intervals.icu resolves them against this value) and its LTHR anchors the
  // HR zones, so this is the authoritative source for what the athlete will
  // ride. Returns null when there is no Ride settings entry at all.
  async getRideSportSettings(): Promise<RideSportSettings | null> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/sport-settings`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const ride = data.find((s) => {
      if (!s || typeof s !== "object") return false;
      const types = (s as Record<string, unknown>).types;
      return Array.isArray(types) && types.includes("Ride");
    }) as Record<string, unknown> | undefined;
    if (!ride || typeof ride.id !== "number") return null;
    // `> 0`: some accounts report an unset FTP/LTHR as 0, which should read as
    // "not set", not a literal 0 (mirrors the v > 0 guard in readiness.ts).
    const positive = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);
    return { id: ride.id, ftp: positive(ride.ftp), lthr: positive(ride.lthr) };
  }

  async getFtp(): Promise<number | null> {
    return (await this.getRideSportSettings())?.ftp ?? null;
  }

  // Partial update of a sport-settings entry (e.g. `{ ftp: 232 }` from the
  // eFTP sync) — the API merges the given fields, like updateActivity.
  async updateSportSettings(id: number, fields: Record<string, unknown>): Promise<void> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/sport-settings/${id}`;
    const res = await this.fetch(url, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
  }

  async getActivities(oldest: string, newest: string): Promise<Activity[]> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/activities?oldest=${oldest}&newest=${newest}`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((raw) => {
      const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const { zoneTimes, ssTime } = normalizeZoneTimes(a.icu_zone_times);
      return {
        id: typeof a.id === "string" ? a.id : String(a.id ?? ""),
        start_date_local: typeof a.start_date_local === "string" ? a.start_date_local : "",
        start_date: typeof a.start_date === "string" ? a.start_date : "",
        type: typeof a.type === "string" ? a.type : "",
        icu_training_load: typeof a.icu_training_load === "number" ? a.icu_training_load : 0,
        icu_intensity: normalizeIntensity(a.icu_intensity),
        icu_zone_times: zoneTimes,
        icu_ss_time: ssTime,
        icu_rolling_ftp:
          typeof a.icu_rolling_ftp === "number" && a.icu_rolling_ftp > 0 ? a.icu_rolling_ftp : null,
      };
    });
  }

  async createEvent(event: IntervalsEvent): Promise<IntervalsEvent> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/events`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  async updateEvent(id: number, event: IntervalsEvent): Promise<IntervalsEvent> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/events/${id}`;
    const res = await this.fetch(url, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  // Activities (completed workouts) are separate from events (planned). Strong
  // strength sessions arrive here via the Intervals.icu Companion Apple Health
  // sync as WeightTraining activities with an empty description.
  //
  // Reads use /activity/{id}, like updateActivity: the athlete-scoped detail
  // endpoint returns description: null even when one is set (observed
  // 2026-07-08), which would blind the importers' non-ours overwrite guard.
  async getActivityDescription(id: string): Promise<string> {
    const url = `${BASE_URL}/activity/${id}`;
    const res = await this.fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    const desc = (data as Record<string, unknown> | null)?.description;
    return typeof desc === "string" ? desc : "";
  }

  async updateActivity(id: string, fields: Record<string, unknown>): Promise<void> {
    // Single-activity writes use the non-athlete-scoped /activity/{id} path;
    // the /athlete/{id}/activities/... path only supports GET (PUT → 405).
    const url = `${BASE_URL}/activity/${id}`;
    const res = await this.fetch(url, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
  }

  // Create a manual activity (no recording file). Used by the Hevy importer
  // when a strength session was logged in Hevy but never recorded on the
  // watch, so no Companion-synced WeightTraining activity exists to decorate.
  async createManualActivity(activity: Record<string, unknown>): Promise<{ id: string }> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/activities/manual`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(activity),
    });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return { id: typeof data.id === "string" ? data.id : String(data.id ?? "") };
  }

  async deleteEvent(id: number): Promise<void> {
    const url = `${BASE_URL}/athlete/${ATHLETE_ID}/events/${id}`;
    const res = await this.fetch(url, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`Intervals.icu API error (${res.status}): ${await res.text()}`);
    }
  }
}
