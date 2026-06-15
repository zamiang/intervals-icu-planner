import { describe, it, expect, vi, beforeEach } from "vitest";
import { IntervalsClient } from "../src/intervals.js";
import type { IntervalsEvent } from "../src/types.js";

const MOCK_EVENTS: IntervalsEvent[] = [
  {
    id: 1,
    start_date_local: "2026-04-20",
    name: "Morning Ride",
    category: "WORKOUT",
    type: "Ride",
  },
];

const MOCK_WELLNESS = [{ id: "2026-04-19", ctl: 55, atl: 60, tsb: -5 }];

describe("IntervalsClient", () => {
  let client: IntervalsClient;
  let mockFetch: ReturnType<typeof vi.fn> & typeof globalThis.fetch;

  beforeEach(() => {
    mockFetch = vi.fn() as typeof mockFetch;
    client = new IntervalsClient("test-api-key", mockFetch);
  });

  describe("getEvents", () => {
    it("fetches events for a date range", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_EVENTS,
      });

      const events = await client.getEvents("2026-04-20", "2026-04-26");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/events?oldest=2026-04-20&newest=2026-04-26",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic"),
          }),
        }),
      );
      expect(events).toEqual(MOCK_EVENTS);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(client.getEvents("2026-04-20", "2026-04-26")).rejects.toThrow(
        "Intervals.icu API error (401)",
      );
    });

    it("coerces malformed events and drops entries with no date", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 1,
            start_date_local: "2026-04-20",
            name: "Ride",
            category: "WORKOUT",
            type: "Ride",
          },
          { name: "no date — should be dropped", category: "WORKOUT" },
          { id: "not-a-number", start_date_local: "2026-04-21", category: "RACE_A" },
        ],
      });

      const events = await client.getEvents("2026-04-20", "2026-04-26");

      expect(events).toHaveLength(2);
      expect(events[0].start_date_local).toBe("2026-04-20");
      expect(events[1]).toMatchObject({ start_date_local: "2026-04-21", category: "RACE_A" });
      expect(events[1].id).toBeUndefined(); // non-numeric id coerced away
      expect(events[1].name).toBe(""); // missing name coerced to ""
    });

    it("returns empty array when the response is not an array", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ error: "boom" }) });
      const events = await client.getEvents("2026-04-20", "2026-04-26");
      expect(events).toEqual([]);
    });
  });

  describe("getTrainingLoad", () => {
    it("fetches wellness data and extracts latest training load", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_WELLNESS,
      });

      const load = await client.getTrainingLoad("2026-04-19");

      expect(load).toEqual({ ctl: 55, atl: 60, tsb: -5 });
    });

    it("returns zeros when the wellness response is an empty array", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const load = await client.getTrainingLoad("2026-04-19");
      expect(load).toEqual({ ctl: 0, atl: 0, tsb: 0 });
    });

    it("defaults missing ctl/atl to zero and derives tsb from ctl - atl", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "2026-04-19", ctl: 55 }],
      });

      const load = await client.getTrainingLoad("2026-04-19");
      expect(load).toEqual({ ctl: 55, atl: 0, tsb: 55 });
    });
  });

  describe("getTrainingLoadRange", () => {
    it("returns parsed wellness entries with dates from the `id` field", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "2026-04-19", ctl: 55, atl: 60, tsb: -5 },
          { id: "2026-04-20", ctl: 56, atl: 62, tsb: -6 },
        ],
      });

      const range = await client.getTrainingLoadRange("2026-04-19", "2026-04-20");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/wellness?oldest=2026-04-19&newest=2026-04-20",
        expect.any(Object),
      );
      expect(range).toEqual([
        { date: "2026-04-19", ctl: 55, atl: 60, tsb: -5 },
        { date: "2026-04-20", ctl: 56, atl: 62, tsb: -6 },
      ]);
    });

    it("returns empty array when the response is not an array", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => null,
      });
      const range = await client.getTrainingLoadRange("2026-04-19", "2026-04-20");
      expect(range).toEqual([]);
    });
  });

  describe("getActivities", () => {
    it("fetches activities and normalizes the fields we care about", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: "i12345",
            start_date_local: "2026-04-19T08:00:00",
            start_date: "2026-04-19T12:00:00Z",
            type: "Ride",
            icu_training_load: 78,
            icu_intensity: 0.82,
            icu_zone_times: [600, 1200, 1800, 600, 0, 0, 0],
          },
          {
            id: "i12346",
            start_date_local: "2026-04-20T07:30:00",
            type: "Run",
            icu_training_load: 45,
            // missing icu_intensity / icu_zone_times — should null out
          },
        ],
      });

      const activities = await client.getActivities("2026-04-19", "2026-04-20");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/activities?oldest=2026-04-19&newest=2026-04-20",
        expect.any(Object),
      );
      expect(activities).toHaveLength(2);
      expect(activities[0]).toEqual({
        id: "i12345",
        start_date_local: "2026-04-19T08:00:00",
        start_date: "2026-04-19T12:00:00Z",
        type: "Ride",
        icu_training_load: 78,
        icu_intensity: 0.82,
        icu_zone_times: [600, 1200, 1800, 600, 0, 0, 0],
        icu_ss_time: null,
      });
      expect(activities[1].icu_intensity).toBeNull();
      expect(activities[1].icu_zone_times).toBeNull();
      expect(activities[1].icu_ss_time).toBeNull();
      expect(activities[1].start_date).toBe(""); // missing start_date → "" (used by the Hevy matcher)
    });

    it("normalizes the live API shape: percent IF and object-array zone times", async () => {
      // Real response shape observed 2026-06-11: icu_intensity is a percentage
      // and icu_zone_times is [{id, secs}, ...] with a native "SS" bucket.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: "i20001",
            start_date_local: "2026-06-09T08:00:00",
            type: "Ride",
            icu_training_load: 65,
            icu_intensity: 89.3,
            icu_zone_times: [
              { id: "Z1", secs: 758 },
              { id: "Z2", secs: 5400 },
              { id: "Z3", secs: 600 },
              { id: "Z4", secs: 400 },
              { id: "Z5", secs: 120 },
              { id: "Z6", secs: 60 },
              { id: "Z7", secs: 53 },
              { id: "SS", secs: 1260 },
            ],
          },
        ],
      });

      const activities = await client.getActivities("2026-06-09", "2026-06-09");

      expect(activities[0].icu_intensity).toBeCloseTo(0.893);
      expect(activities[0].icu_zone_times).toEqual([758, 5400, 600, 400, 120, 60, 53]);
      expect(activities[0].icu_ss_time).toBe(1260);
    });

    it("returns empty array when response is not an array", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
      const activities = await client.getActivities("2026-04-19", "2026-04-20");
      expect(activities).toEqual([]);
    });
  });

  describe("getActivityDescription", () => {
    it("fetches the activity and returns its description", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "i999", description: "— logged from Strong —\nSquat: 6@90lb" }),
      });

      const desc = await client.getActivityDescription("i999");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/activities/i999",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: expect.stringContaining("Basic") }),
        }),
      );
      expect(desc).toBe("— logged from Strong —\nSquat: 6@90lb");
    });

    it("returns '' when the activity has no (or a non-string) description", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "i999" }) });
      expect(await client.getActivityDescription("i999")).toBe("");

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ description: null }) });
      expect(await client.getActivityDescription("i999")).toBe("");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not Found" });
      await expect(client.getActivityDescription("i999")).rejects.toThrow(
        "Intervals.icu API error (404)",
      );
    });
  });

  describe("updateActivity", () => {
    it("PUTs to the /activity/{id} endpoint (not /athlete/0/activities/{id})", async () => {
      // Regression guard: single-activity writes must use /activity/{id}; the
      // athlete-scoped path is GET-only and returns 405 on PUT.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await client.updateActivity("i999", { description: "new" });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/activity/i999",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ description: "new" }),
        }),
      );
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).not.toContain("/athlete/");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 405,
        text: async () => "Method Not Allowed",
      });
      await expect(client.updateActivity("i999", { description: "x" })).rejects.toThrow(
        "Intervals.icu API error (405)",
      );
    });
  });

  describe("createEvent", () => {
    it("posts an event to the calendar", async () => {
      const event: IntervalsEvent = {
        start_date_local: "2026-04-21",
        name: "Strength Session",
        category: "WORKOUT",
        type: "WeightTraining",
        description: "Squats and stuff",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...event, id: 42 }),
      });

      const created = await client.createEvent(event);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/events",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(event),
        }),
      );
      expect(created.id).toBe(42);
    });

    it("serializes planned-load fields when present", async () => {
      const event: IntervalsEvent = {
        start_date_local: "2026-06-13",
        name: "Endurance Z2 Ride",
        category: "WORKOUT",
        type: "Ride",
        description: "Long easy ride",
        icu_training_load: 75,
        moving_time: 6300,
        icu_intensity: 0.65,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...event, id: 7 }),
      });

      await client.createEvent(event);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        icu_training_load: 75,
        moving_time: 6300,
        icu_intensity: 0.65,
      });
    });
  });

  describe("updateEvent", () => {
    it("PUTs an event to its id endpoint", async () => {
      const event: IntervalsEvent = {
        start_date_local: "2026-06-13",
        name: "Endurance Z2 Ride",
        category: "WORKOUT",
        type: "Ride",
        icu_training_load: 75,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...event, id: 42 }),
      });

      const updated = await client.updateEvent(42, event);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/events/42",
        expect.objectContaining({ method: "PUT", body: JSON.stringify(event) }),
      );
      expect(updated.id).toBe(42);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      });

      await expect(
        client.updateEvent(99, {
          start_date_local: "2026-06-13",
          name: "x",
          category: "WORKOUT",
        }),
      ).rejects.toThrow("Intervals.icu API error (404)");
    });
  });

  describe("deleteEvent", () => {
    it("DELETEs an event by id", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

      await client.deleteEvent(42);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://intervals.icu/api/v1/athlete/0/events/42",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });

      await expect(client.deleteEvent(42)).rejects.toThrow("Intervals.icu API error (403)");
    });
  });
});
