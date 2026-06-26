export interface ComposerNativeEventSnapshot {
  readonly eventCount: number;
  readonly value: string;
  readonly selection: ComposerEditorSelection | null;
}

interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

export function acknowledgeComposerNativeEvent(
  mostRecentEventCount: number,
  incomingEventCount: number,
): number | null {
  if (!Number.isSafeInteger(incomingEventCount) || incomingEventCount < mostRecentEventCount) {
    return null;
  }
  return incomingEventCount;
}

export function resolveComposerControlledEventCount(
  value: string,
  selection: ComposerEditorSelection | null,
  mostRecentEventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): number {
  let newestValueEventCount: number | null = null;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot?.value !== value) continue;

    newestValueEventCount ??= snapshot.eventCount;
    if (
      selection === null ||
      (snapshot.selection?.start === selection.start && snapshot.selection.end === selection.end)
    ) {
      return snapshot.eventCount;
    }
  }

  // A value emitted by native paired with a different selection is an
  // intermediate React render. Keep it behind the native revision so it
  // cannot move the caret while newer keystrokes are being processed.
  if (newestValueEventCount !== null && mostRecentEventCount > 0) {
    return Math.min(newestValueEventCount, mostRecentEventCount - 1);
  }

  return mostRecentEventCount;
}

export function resolveComposerControlledSelection(
  value: string,
  selection: ComposerEditorSelection | null,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): ComposerEditorSelection | null {
  if (selection === null) return null;
  const lastSnapshot = snapshots[snapshots.length - 1];
  if (lastSnapshot !== undefined && lastSnapshot.value === value) {
    return null;
  }
  return selection;
}

export function isComposerNativeValue(
  value: string,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): boolean {
  const lastSnapshot = snapshots[snapshots.length - 1];
  return lastSnapshot !== undefined && lastSnapshot.value === value;
}
