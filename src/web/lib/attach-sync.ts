/** Client attach lifecycle — block resize until hello/snapshot restore completes. */
export type AttachPhase = 'connecting' | 'restoring' | 'ready';

export function canSyncTermSize(phase: AttachPhase): boolean {
  return phase === 'ready';
}
