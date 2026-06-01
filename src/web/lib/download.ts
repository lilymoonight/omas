/** Trigger a browser download for in-memory content (no server round-trip). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been processed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Filesystem-safe timestamp like 2026-06-01_00-30-12 for export filenames. */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Strip characters that are awkward in filenames; collapse whitespace to dashes. */
export function safeFileLabel(label: string, fallback = 'session'): string {
  const cleaned = label
    .trim()
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return cleaned || fallback;
}
