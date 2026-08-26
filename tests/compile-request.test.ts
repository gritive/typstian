import { afterEach, describe, expect, it } from "vitest";

import { hostClock } from "../src/compile-request";

const originalTimezone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimezone;
});

describe("hostClock", () => {
  it("reports the minutes to add to UTC, not the minutes to subtract", () => {
    // `Date.prototype.getTimezoneOffset` counts the other way around, so an
    // unnegated offset would shift `datetime.today()` by twice the offset.
    process.env.TZ = "Asia/Seoul";
    expect(hostClock().localOffsetMinutes).toBe(540);

    process.env.TZ = "Asia/Kolkata";
    expect(hostClock().localOffsetMinutes).toBe(330);

    process.env.TZ = "Pacific/Honolulu";
    expect(hostClock().localOffsetMinutes).toBe(-600);
  });

  it("samples the instant as milliseconds since the Unix epoch", () => {
    process.env.TZ = "Asia/Seoul";
    const before = Date.now();
    const sampled = hostClock().nowMs;

    expect(sampled).toBeGreaterThanOrEqual(before);
    expect(sampled).toBeLessThanOrEqual(Date.now());
  });
});
