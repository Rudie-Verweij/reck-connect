import { describe, it, expect } from "vitest";
import {
  NAV_HEIGHT,
  POPUP_HEADER_HEIGHT,
  trafficLightPositionFor,
} from "./window-chrome";

describe("trafficLightPositionFor", () => {
  // The lights are a 12px cluster whose `y` is its TOP, so a correctly centred
  // cluster has `y + 6 === height / 2`.
  function clusterCentre(height: number): number {
    return trafficLightPositionFor(height).y + 6;
  }

  it("centres the cluster in the popup title bar", () => {
    expect(clusterCentre(POPUP_HEADER_HEIGHT)).toBe(POPUP_HEADER_HEIGHT / 2);
  });

  it("centres the cluster in the main window nav", () => {
    expect(clusterCentre(NAV_HEIGHT)).toBe(NAV_HEIGHT / 2);
  });

  it("gives DIFFERENT positions for the two bar heights", () => {
    // The bug: one shared `y: 16` sat 3px low in the 38px popup bars and 3px
    // high in the 50px nav, so the dots never lined up with the title text.
    expect(trafficLightPositionFor(POPUP_HEADER_HEIGHT).y).not.toBe(
      trafficLightPositionFor(NAV_HEIGHT).y,
    );
  });

  it("no longer returns the old shared value for either bar", () => {
    expect(trafficLightPositionFor(POPUP_HEADER_HEIGHT).y).not.toBe(16);
    expect(trafficLightPositionFor(NAV_HEIGHT).y).not.toBe(16);
  });

  it("keeps the left inset stable across heights", () => {
    expect(trafficLightPositionFor(38).x).toBe(trafficLightPositionFor(50).x);
  });

  it("returns whole pixels for odd heights", () => {
    expect(Number.isInteger(trafficLightPositionFor(39).y)).toBe(true);
  });
});
