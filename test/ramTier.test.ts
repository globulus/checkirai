import { describe, expect, it } from "vitest";
import {
  bytesToGiB,
  suggestMaxApproxQ4ModelRamGiB,
  suggestProfileKeyFromTotalRamGiB,
} from "../src/llm/ramTier.js";

describe("ramTier", () => {
  it("maps GiB to profile keys per hardware plan", () => {
    expect(suggestProfileKeyFromTotalRamGiB(8)).toBe("laptop_16gb");
    expect(suggestProfileKeyFromTotalRamGiB(16)).toBe("laptop_16gb");
    expect(suggestProfileKeyFromTotalRamGiB(24)).toBe("workstation_24gb");
    expect(suggestProfileKeyFromTotalRamGiB(64)).toBe("high_end_40gb");
  });

  it("suggestMaxApproxQ4ModelRamGiB scales with host RAM", () => {
    expect(suggestMaxApproxQ4ModelRamGiB(16)).toBe(8);
    expect(suggestMaxApproxQ4ModelRamGiB(32)).toBe(16);
  });

  it("bytesToGiB is consistent", () => {
    expect(bytesToGiB(16 * 1024 ** 3)).toBe(16);
  });
});
