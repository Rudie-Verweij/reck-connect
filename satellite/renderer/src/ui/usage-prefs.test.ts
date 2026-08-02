import { describe, it, expect } from "vitest";
import {
  DEFAULT_USAGE_PREFS,
  bucketFor,
  isBucketValidFor,
  noSeriesVisible,
  sanitizeUsagePrefs,
} from "./usage-prefs";
import { BIN_OPTIONS, defaultBinFor } from "./usage-range";

describe("isBucketValidFor", () => {
  it("accepts every width the granularity offers", () => {
    for (const [g, widths] of Object.entries(BIN_OPTIONS)) {
      for (const w of widths) {
        expect(isBucketValidFor(g as never, w)).toBe(true);
      }
    }
  });

  it("rejects a width from a different granularity", () => {
    // The realistic case: 1m is a Day width, and the user switches to Month.
    expect(isBucketValidFor("day", "1m")).toBe(true);
    expect(isBucketValidFor("month", "1m")).toBe(false);
    expect(isBucketValidFor("day", "month")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isBucketValidFor("day", 5)).toBe(false);
    expect(isBucketValidFor("day", null)).toBe(false);
    expect(isBucketValidFor("day", undefined)).toBe(false);
  });
});

describe("sanitizeUsagePrefs", () => {
  it("round-trips a valid blob", () => {
    const prefs = {
      granularity: "day" as const,
      buckets: { day: "1m" as const, week: "4h" as const },
      session: false,
      projectId: "proj-x",
      shown: { tokens: false, fiveHour: true, sevenDay: false },
    };
    expect(sanitizeUsagePrefs(prefs)).toEqual(prefs);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "week"],
    ["a number", 7],
    ["an array", []],
  ])("falls back to defaults for %s", (_label, raw) => {
    expect(sanitizeUsagePrefs(raw)).toEqual(DEFAULT_USAGE_PREFS);
  });

  it("keeps a good granularity when a remembered width is nonsense", () => {
    // Field-by-field, not all-or-nothing: losing the granularity because a
    // width was bad would throw away the more important half.
    const out = sanitizeUsagePrefs({ granularity: "day", buckets: { day: "42q" } });
    expect(out.granularity).toBe("day");
    expect(out.buckets.day).toBeUndefined();
  });

  it("drops a width its own granularity does not offer", () => {
    // "1m" is a Day width; on Month it would reach the daemon as a bad query.
    const out = sanitizeUsagePrefs({ buckets: { day: "1m", month: "1m", week: "4h" } });
    expect(out.buckets).toEqual({ day: "1m", week: "4h" });
  });

  it("drops a non-string projectId", () => {
    expect(sanitizeUsagePrefs({ projectId: 42 }).projectId).toBe("");
    expect(sanitizeUsagePrefs({ projectId: null }).projectId).toBe("");
  });

  it("keeps the empty projectId meaning 'all projects'", () => {
    expect(sanitizeUsagePrefs({ projectId: "" }).projectId).toBe("");
  });

  it("fills only the missing series flags", () => {
    const out = sanitizeUsagePrefs({ shown: { tokens: false } });
    expect(out.shown).toEqual({ tokens: false, fiveHour: true, sevenDay: true });
  });

  it("ignores non-boolean series flags", () => {
    const out = sanitizeUsagePrefs({
      shown: { tokens: "no", fiveHour: 0, sevenDay: false },
    });
    expect(out.shown).toEqual({ tokens: true, fiveHour: true, sevenDay: false });
  });

  it("survives a shown field that isn't an object", () => {
    expect(sanitizeUsagePrefs({ shown: "all" }).shown).toEqual(
      DEFAULT_USAGE_PREFS.shown,
    );
  });

  it("allows all three series to be off", () => {
    // The state the red overlay exists for — it must persist, not be repaired.
    const out = sanitizeUsagePrefs({
      shown: { tokens: false, fiveHour: false, sevenDay: false },
    });
    expect(noSeriesVisible(out.shown)).toBe(true);
  });

  it("never carries an anchor date through", () => {
    // Reopening "Day" shows today, not the day you were paging through.
    const out = sanitizeUsagePrefs({
      granularity: "day",
      periodStart: "2026-03-03T00:00:00Z",
      custom: { since: 1, until: 2 },
    }) as unknown as Record<string, unknown>;
    expect(out.periodStart).toBeUndefined();
    expect(out.custom).toBeUndefined();
  });

  it("returns a fresh object each time", () => {
    // The overlay mutates its copy; leaking the shared default would make the
    // "defaults" drift for the rest of the session.
    const a = sanitizeUsagePrefs(null);
    a.shown.tokens = false;
    expect(sanitizeUsagePrefs(null).shown.tokens).toBe(true);
    expect(DEFAULT_USAGE_PREFS.shown.tokens).toBe(true);
  });
});

describe("noSeriesVisible", () => {
  it("is true only when every series is off", () => {
    expect(noSeriesVisible({ tokens: false, fiveHour: false, sevenDay: false })).toBe(true);
  });

  it.each([
    ["tokens", { tokens: true, fiveHour: false, sevenDay: false }],
    ["5h", { tokens: false, fiveHour: true, sevenDay: false }],
    ["7d", { tokens: false, fiveHour: false, sevenDay: true }],
  ])("is false when %s is on", (_label, shown) => {
    expect(noSeriesVisible(shown)).toBe(false);
  });
});

describe("remembering a width per view", () => {
  it("keeps each granularity's width independent", () => {
    // The bug this exists for: picking 1m on Day and glancing at Week used to
    // throw the choice away, because coming back ran the Day default.
    const out = sanitizeUsagePrefs({
      granularity: "day",
      buckets: { day: "1m", week: "1d", month: "4h" },
    });
    expect(bucketFor(out.buckets, "day")).toBe("1m");
    expect(bucketFor(out.buckets, "week")).toBe("1d");
    expect(bucketFor(out.buckets, "month")).toBe("4h");
  });

  it("falls back to a granularity's default when it has no entry", () => {
    const out = sanitizeUsagePrefs({ buckets: { day: "1m" } });
    expect(bucketFor(out.buckets, "day")).toBe("1m");
    expect(bucketFor(out.buckets, "year")).toBe("month");
    expect(bucketFor({}, "week")).toBe("30m");
  });

  it("adopts a pre-upgrade flat width for the view it was chosen on", () => {
    // Older releases stored one `bucket` for all views. Upgrading must not
    // silently discard the width someone had set.
    const out = sanitizeUsagePrefs({ granularity: "day", bucket: "1m" });
    expect(out.buckets.day).toBe("1m");
    // …but only where it is valid: "1m" is not a Month width.
    expect(sanitizeUsagePrefs({ granularity: "month", bucket: "1m" }).buckets.month).toBeUndefined();
  });

  it("never lets the legacy field override an explicit per-view entry", () => {
    const out = sanitizeUsagePrefs({ granularity: "day", bucket: "4h", buckets: { day: "1m" } });
    expect(out.buckets.day).toBe("1m");
  });
});

describe("remembering which view was open", () => {
  it("round-trips the session flag", () => {
    expect(sanitizeUsagePrefs({ session: true }).session).toBe(true);
    expect(sanitizeUsagePrefs({ session: false }).session).toBe(false);
  });

  it("defaults to off, and treats anything non-boolean as off", () => {
    expect(sanitizeUsagePrefs({}).session).toBe(false);
    expect(sanitizeUsagePrefs({ session: "yes" }).session).toBe(false);
    expect(sanitizeUsagePrefs({ session: 1 }).session).toBe(false);
  });

  it("keeps the calendar view alongside it, to fall back to on exit", () => {
    const out = sanitizeUsagePrefs({ granularity: "day", session: true });
    expect(out.session).toBe(true);
    expect(out.granularity).toBe("day");
  });
});
