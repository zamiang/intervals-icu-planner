import { describe, it, expect } from "vitest";
import {
  CUSTOM_ITEM_DEFS,
  deepSubset,
  planSync,
  type CustomItemDef,
  type RemoteCustomItem,
} from "../src/customItems.js";

const DEF: CustomItemDef = {
  type: "ACTIVITY_FIELD",
  name: "Temp Drift",
  description: "2nd-half minus 1st-half temp.",
  content: { code: "TempDrift", script: "1 + 1", number_format: ".1f" },
};

function remote(overrides: Partial<RemoteCustomItem> = {}): RemoteCustomItem {
  return {
    id: 42,
    type: DEF.type,
    name: DEF.name,
    description: DEF.description,
    content: { ...DEF.content },
    ...overrides,
  };
}

describe("deepSubset", () => {
  it("matches identical primitives and rejects different ones", () => {
    expect(deepSubset(1, 1)).toBe(true);
    expect(deepSubset("a", "b")).toBe(false);
    expect(deepSubset(null, null)).toBe(true);
  });

  it("ignores extra keys on the actual side", () => {
    expect(deepSubset({ a: 1 }, { a: 1, serverAdded: "x" })).toBe(true);
  });

  it("rejects a missing expected key", () => {
    // null on the expected side must not match an absent key: the server
    // storing nothing where we define null is drift.
    expect(deepSubset({ a: null }, {})).toBe(false);
  });

  it("compares arrays element-wise and by length", () => {
    expect(deepSubset([{ a: 1 }], [{ a: 1, extra: 2 }])).toBe(true);
    expect(deepSubset([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(deepSubset([1, 2], [2, 1])).toBe(false);
  });

  it("recurses into nested objects", () => {
    expect(deepSubset({ a: { b: [1] } }, { a: { b: [1], c: 2 }, d: 3 })).toBe(true);
    expect(deepSubset({ a: { b: [1] } }, { a: { b: [2] } })).toBe(false);
  });
});

describe("planSync", () => {
  it("creates when no item with the same type and name exists", () => {
    const plan = planSync([DEF], []);
    expect(plan.create).toEqual([DEF]);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual([]);
  });

  it("does not match an item of a different type with the same name", () => {
    const plan = planSync([DEF], [remote({ type: "FITNESS_CHART" })]);
    expect(plan.create).toEqual([DEF]);
  });

  it("reports unchanged when stored content is a superset of the definition", () => {
    const stored = remote();
    (stored.content as Record<string, unknown>).usage_count = 3; // server-added
    const plan = planSync([DEF], [stored]);
    expect(plan.unchanged).toEqual([{ id: 42, def: DEF }]);
    expect(plan.update).toEqual([]);
  });

  it("updates when the script drifted", () => {
    const stored = remote({ content: { ...DEF.content, script: "2 + 2" } });
    const plan = planSync([DEF], [stored]);
    expect(plan.update).toEqual([{ id: 42, def: DEF }]);
  });

  it("updates when the description drifted", () => {
    const plan = planSync([DEF], [remote({ description: "old text" })]);
    expect(plan.update).toEqual([{ id: 42, def: DEF }]);
  });

  it("treats a missing remote description as empty, not as a match", () => {
    const stored = remote();
    delete stored.description;
    const plan = planSync([DEF], [stored]);
    expect(plan.update).toEqual([{ id: 42, def: DEF }]);
  });

  it("leaves undefined account items alone", () => {
    const foreign = remote({ id: 7, name: "Hand-made chart", type: "FITNESS_CHART" });
    const plan = planSync([DEF], [foreign, remote()]);
    expect(plan.unchanged).toEqual([{ id: 42, def: DEF }]);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
  });
});

describe("CUSTOM_ITEM_DEFS", () => {
  it("defines the four charts and four fields with unique names", () => {
    const charts = CUSTOM_ITEM_DEFS.filter((d) => d.type === "FITNESS_CHART");
    const fields = CUSTOM_ITEM_DEFS.filter((d) => d.type === "ACTIVITY_FIELD");
    expect(charts).toHaveLength(4);
    expect(fields).toHaveLength(4);
    const names = CUSTOM_ITEM_DEFS.map((d) => `${d.type}:${d.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every activity field a code and a guarded script", () => {
    for (const def of CUSTOM_ITEM_DEFS.filter((d) => d.type === "ACTIVITY_FIELD")) {
      const c = def.content as Record<string, unknown>;
      expect(typeof c.code).toBe("string");
      const script = c.script as string;
      // Server-side field scripts must not blow up analysis on rides without
      // the stream (missing streams throw on access) and must end with the
      // value expression the sandbox stores.
      expect(script).toContain("try");
      expect(script).toContain("catch");
      expect(script.trimEnd().endsWith("v\n}")).toBe(true);
    }
  });

  it("filters every fitness-chart plot to ride types", () => {
    for (const def of CUSTOM_ITEM_DEFS.filter((d) => d.type === "FITNESS_CHART")) {
      const plots = (def.content as Record<string, unknown>).plots as Record<string, unknown>[];
      expect(plots.length).toBeGreaterThan(0);
      for (const p of plots) {
        const filters = p.filters as { field_id: string; value: string[] }[];
        expect(filters[0].field_id).toBe("type");
        expect(filters[0].value).toContain("Ride");
      }
    }
  });
});

// Run a field script the way the Intervals.icu sandbox does: the block's last
// expression is the stored value. A direct eval returns a block's completion
// value and sees the enclosing `icu` parameter, so the script runs verbatim.
function runField(code: string, icu: unknown): unknown {
  const def = CUSTOM_ITEM_DEFS.find(
    (d) => d.type === "ACTIVITY_FIELD" && (d.content as { code: string }).code === code,
  )!;
  const script = (def.content as { script: string }).script;
  return new Function("icu", `return eval(${JSON.stringify(script)})`)(icu);
}

// A synthetic ride: `n` seconds at `watts`, breathing `br` breaths/min of
// `tv` tidal volume. Tidal volume wobbles ±1 so the Tymewear gate sees a live
// stream; `ve2` scales second-half ventilation for drift/decoupling cases.
function strapRide(
  n: number,
  opts: {
    watts?: number;
    br?: number;
    tv?: number;
    ve2?: number;
    flatTv?: boolean;
    noTv?: boolean;
  } = {},
) {
  const { watts = 150, br = 30, tv = 200, ve2 = 1, flatTv = false, noTv = false } = opts;
  const half = n >> 1;
  const streams: Record<string, number[]> = {
    fixed_watts: Array.from({ length: n }, () => watts),
    respiration: Array.from({ length: n }, (_, i) => br * (i >= half ? ve2 : 1)),
  };
  if (!noTv)
    streams.tidal_volume = Array.from({ length: n }, (_, i) =>
      flatTv ? tv : tv + (i % 2 ? 1 : -1),
    );
  return { streams, activity: { icu_ftp: 230 } };
}

describe("breathing field scripts", () => {
  it("VentEff: endurance-band watts per unit ventilation, scaled ×1000", () => {
    // 150 W is 65% of 230 FTP; VE ≈ 30 × 200 → 150 / 6000 × 1000 = 25.
    expect(runField("VentEff", strapRide(3600)) as number).toBeCloseTo(25, 1);
  });

  it("VentEff: no value without 20 minutes in the endurance band", () => {
    expect(runField("VentEff", strapRide(1700))).toBeNull(); // 10 min skipped + < 20 in band
    expect(runField("VentEff", strapRide(3600, { watts: 220 }))).toBeNull(); // threshold, not endurance
  });

  it("all breathing fields reject rides without the strap or with a flatlined tidal volume", () => {
    for (const code of ["VentEff", "RespDrift", "RespDecoupling"]) {
      // Edge 840's HR-derived breathing rate alone: respiration but no tidal volume.
      expect(runField(code, strapRide(3600, { noTv: true }))).toBeNull();
      // Strap dropout: tidal volume pinned at one value all ride.
      expect(runField(code, strapRide(3600, { flatTv: true }))).toBeNull();
    }
  });

  it("RespDecoupling uses ventilation: 10% more air in the 2nd half at equal power ≈ 10%", () => {
    expect(runField("RespDecoupling", strapRide(3600, { ve2: 1.1 })) as number).toBeCloseTo(10, 0);
    expect(runField("RespDrift", strapRide(3600, { ve2: 1.1 })) as number).toBeCloseTo(10, 0);
  });
});
