/** Rough jsonl line count from file size — avoids full-file scans on history refresh. */
export function estimateJsonlLines(byteSize: number): number {
  if (byteSize <= 0) return 0;
  // Agent jsonl lines are typically a few hundred bytes each.
  return Math.max(1, Math.round(byteSize / 280));
}
