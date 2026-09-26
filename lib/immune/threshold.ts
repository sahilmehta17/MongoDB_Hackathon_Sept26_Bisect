// Similarity threshold for recognizing a proposed rule as a known bad habit (Atlas Vector Search
// score, (1 + cosine) / 2). Chosen by scripts/calibrate-immune.ts from data/immune_calibration.yaml
// and fixed afterwards; null until calibrated, and recognition refuses to run without it.
export const IMMUNE_THRESHOLD: number | null = null;
export const IMMUNE_TOP_K = 3;
