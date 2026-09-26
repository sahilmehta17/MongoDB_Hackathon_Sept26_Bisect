// Similarity threshold for recognizing a proposed rule as a known bad habit (Atlas Vector Search
// score, (1 + cosine) / 2). Chosen by scripts/calibrate-immune.ts from data/immune_calibration.yaml
// and fixed afterwards; null until calibrated, and recognition refuses to run without it.
// Calibrated 2026-09-26 from data/immune_calibration.yaml (9 rewordings of H1-H3, 10 useful lessons):
// rewordings scored 0.787-0.873 against their own rule; useful lessons up to 0.862 (the correct
// opposite of H2), so similarity alone overlaps by 0.075. 0.786 keeps every rewording; look-alike
// useful rules are replayed (5 runs) and pass, never blocked on similarity. Fixed; the holdout is
// tested against this value only.
export const IMMUNE_THRESHOLD: number | null = 0.786;
export const IMMUNE_TOP_K = 3;
// What the calibration printout showed when the threshold was fixed.
export const CALIBRATION = { rewordings: 9, useful: 10, lowestRewording: 0.787, highestUseful: 0.862 };
