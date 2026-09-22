import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeBlock,
  blockWeek,
  CTL_WEEK_RESPONSE,
  floorTargetTss,
  projectCtl,
  windowTss,
} from "../src/blocks.js";
import { loadConfig } from "../src/config.js";
import { formatBlock } from "../src/cli.js";
import type { Config, TrainingBlock } from "../src/types.js";

const AUTUMN: TrainingBlock = {
  name: "Autumn VO2",
  start_date: "2026-09-19",
  end_date: "2026-11-22",
  hard_zone_focus: "vo2",
};
const WINTER: TrainingBlock = {
  name: "Winter base",
  start_date: "2026-12-07",
  end_date: "2027-02-28",
  ctl_floor: 48,
};

describe("activeBlock", () => {
  it("matches inclusively on both ends and nothing in the gap", () => {
    const blocks = [AUTUMN, WINTER];
    expect(activeBlock("2026-09-19", blocks)).toBe(AUTUMN);
    expect(activeBlock("2026-11-22", blocks)).toBe(AUTUMN);
    expect(activeBlock("2026-11-23", blocks)).toBeUndefined();
    expect(activeBlock("2027-01-15", blocks)).toBe(WINTER);
    expect(activeBlock("2026-01-15", undefined)).toBeUndefined();
  });
});

describe("blockWeek", () => {
  it("counts 1-based weeks and rounds a partial final week up", () => {
    expect(blockWeek("2026-09-19", AUTUMN)).toEqual({ week: 1, of: 10 });
    expect(blockWeek("2026-09-26", AUTUMN)).toEqual({ week: 2, of: 10 });
    expect(blockWeek("2026-11-22", AUTUMN)).toEqual({ week: 10, of: 10 });
    expect(blockWeek("2026-12-07", WINTER)).toEqual({ week: 1, of: 12 });
  });
});

describe("projectCtl / floorTargetTss", () => {
  it("holds CTL steady when the week averages CTL per day", () => {
    expect(projectCtl(50, 350)).toBeCloseTo(50);
    expect(projectCtl(50, 0)).toBeCloseTo(50 * (1 - CTL_WEEK_RESPONSE));
  });

  it("targets exactly the load that lands on the floor", () => {
    const target = floorTargetTss(45, 48, 7);
    expect(projectCtl(45, target)).toBeCloseTo(48, 0);
  });

  it("abstains with no CTL history rather than prescribe from nothing", () => {
    expect(floorTargetTss(0, 48, 7)).toBe(0);
  });

  it("caps the climb back at the ramp guard's rate", () => {
    // CTL 33 after a break, floor 48: reaching 48 in a week would be a ~45%
    // ramp; the cap holds it to max_weekly_ramp_pct.
    const target = floorTargetTss(33, 48, 7);
    expect(projectCtl(33, target)).toBeCloseTo(33 * 1.07, 0);
  });
});

describe("windowTss", () => {
  it("adds calendar load inside the window and ignores load outside it", () => {
    const planned = [
      {
        date: "2026-12-07",
        type: "cycling" as const,
        name: "",
        description: "",
        intensity: "easy" as const,
        load: 48,
      },
    ];
    const existing = [
      { start_date_local: "2026-12-10T00:00:00", name: "Ride", icu_training_load: 100 },
      { start_date_local: "2026-12-14T00:00:00", name: "Next week", icu_training_load: 999 },
      { start_date_local: "2026-12-06T00:00:00", name: "Yesterday", icu_training_load: 999 },
    ];
    expect(windowTss(planned, existing, "2026-12-07")).toBe(148);
  });
});

describe("formatBlock", () => {
  const cfg = {
    scheduling: { hard_zone_focus: null },
    blocks: [AUTUMN, WINTER],
  } as unknown as Config;

  it("names the block, its week and its focus", () => {
    expect(formatBlock("2026-09-21", cfg, 45)).toBe(
      "Autumn VO2 (week 1 of 10, ends 2026-11-22) — VO2 Max focus",
    );
  });

  it("shows the floor and the projection when given the week's load", () => {
    expect(formatBlock("2026-12-07", cfg, 47, 350)).toBe(
      "Winter base (week 1 of 12, ends 2027-02-28) — CTL 47.0 vs floor 48, 47.5 projected after this week",
    );
  });

  it("points at the next block from a gap", () => {
    expect(formatBlock("2026-11-30", cfg, 45)).toBe("none — next: Winter base from 2026-12-07");
  });
});

describe("loadConfig blocks", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-blocks-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const BASE = `
weight_training: { name: "S", duration_minutes: 60, description: "x" }
sweet_spot: { name: "SS", duration_minutes: 60, description: "x" }
`;
  const load = async (extra: string): Promise<Config> => {
    const file = path.join(tmpDir, "config.yaml");
    await fs.writeFile(file, BASE + extra, "utf8");
    return loadConfig(file);
  };

  it("defaults to no blocks and a 120-minute easy ceiling", async () => {
    const cfg = await load("");
    expect(cfg.blocks).toEqual([]);
    expect(cfg.load_targets.easy_max_minutes).toBe(120);
  });

  it("parses blocks and sorts them by start date", async () => {
    const cfg = await load(`
blocks:
  - { name: "Winter", start_date: "2026-12-07", end_date: "2027-02-28", ctl_floor: 48 }
  - { name: "Autumn", start_date: "2026-09-19", end_date: "2026-11-22", hard_zone_focus: vo2 }
`);
    expect(cfg.blocks!.map((b) => b.name)).toEqual(["Autumn", "Winter"]);
    expect(cfg.blocks![0]).toEqual({
      name: "Autumn",
      start_date: "2026-09-19",
      end_date: "2026-11-22",
      hard_zone_focus: "vo2",
    });
    expect(cfg.blocks![1].ctl_floor).toBe(48);
  });

  it("keeps an explicit null focus distinct from an omitted one", async () => {
    const cfg = await load(`
blocks:
  - { name: "A", start_date: "2026-01-01", end_date: "2026-01-31", hard_zone_focus: null }
  - { name: "B", start_date: "2026-02-01", end_date: "2026-02-28" }
`);
    expect(cfg.blocks![0].hard_zone_focus).toBeNull();
    expect("hard_zone_focus" in cfg.blocks![1]).toBe(false);
  });

  it.each([
    [
      "overlapping blocks",
      `
  - { name: "A", start_date: "2026-01-01", end_date: "2026-01-31" }
  - { name: "B", start_date: "2026-01-31", end_date: "2026-02-28" }`,
      /overlap/,
    ],
    [
      "an inverted window",
      `
  - { name: "A", start_date: "2026-02-01", end_date: "2026-01-01" }`,
      /start_date must not be after/,
    ],
    [
      "a malformed date",
      `
  - { name: "A", start_date: "Jan 1 2026", end_date: "2026-01-31" }`,
      /YYYY-MM-DD/,
    ],
    [
      "a missing name",
      `
  - { start_date: "2026-01-01", end_date: "2026-01-31" }`,
      /name/,
    ],
    [
      "a bad focus",
      `
  - { name: "A", start_date: "2026-01-01", end_date: "2026-01-31", hard_zone_focus: sweet_spot }`,
      /hard_zone_focus/,
    ],
    [
      "a non-positive floor",
      `
  - { name: "A", start_date: "2026-01-01", end_date: "2026-01-31", ctl_floor: 0 }`,
      /ctl_floor/,
    ],
  ])("rejects %s", async (_label, body, err) => {
    await expect(load(`blocks:${body}\n`)).rejects.toThrow(err);
  });

  it("rejects an easy ceiling below the standard easy ride", async () => {
    await expect(
      load("load_targets: { easy_minutes: 90, easy_max_minutes: 60 }\n"),
    ).rejects.toThrow(/easy_max_minutes/);
  });

  it("loads the repo's own config.yaml", async () => {
    const cfg = await loadConfig("config.yaml");
    expect(cfg.blocks!.length).toBeGreaterThan(0);
  });
});
