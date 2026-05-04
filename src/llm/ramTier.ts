import { totalmem } from "node:os";

/** Physical RAM reported by the OS (may exceed what is free for inference). */
export function getHostTotalMemoryBytes(): number {
  return totalmem();
}

export function bytesToGiB(bytes: number): number {
  return bytes / 1024 ** 3;
}

/**
 * Maps total system RAM to a hardware profile key from
 * `checkirai_llm_implementation_plan.md` (laptop_16gb / workstation_24gb / high_end_40gb).
 * Thresholds are conservative: many models loaded together need headroom.
 */
export function suggestProfileKeyFromTotalRamGiB(totalGiB: number): string {
  if (totalGiB < 18) return "laptop_16gb";
  if (totalGiB < 34) return "workstation_24gb";
  return "high_end_40gb";
}

export function ramTierRationale(totalGiB: number, profileKey: string): string {
  if (profileKey === "laptop_16gb") {
    return `~${totalGiB.toFixed(1)} GiB system RAM: prefer smaller Q4 models (e.g. 7B normalizer, 14B judge) per hardware-gated profiles.`;
  }
  if (profileKey === "workstation_24gb") {
    return `~${totalGiB.toFixed(1)} GiB system RAM: 14B normalization + DeepSeek-class judge is reasonable; avoid 32B+ unless you run one model at a time.`;
  }
  return `~${totalGiB.toFixed(1)} GiB system RAM: room for 14B + 32B-class judge / triage per high-end profile (still watch concurrent loads).`;
}

/** Heuristic: models with approxQ4RamGb above this are unlikely to fit alongside Ollama overhead. */
export function suggestMaxApproxQ4ModelRamGiB(totalGiB: number): number {
  return Math.max(5, Math.floor(totalGiB / 2));
}
