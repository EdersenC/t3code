import { describe, expect, it } from "@effect/vitest";

import {
  acknowledgeComposerNativeEvent,
  isComposerNativeEcho,
  resolveComposerControlledEventCount,
} from "./composerEditorRevision";

describe("acknowledgeComposerNativeEvent", () => {
  it("advances to newer native text revisions", () => {
    expect(acknowledgeComposerNativeEvent(4, 5)).toBe(5);
  });

  it("accepts a duplicate event from the current native revision", () => {
    expect(acknowledgeComposerNativeEvent(5, 5)).toBe(5);
  });

  it("rejects events older than the latest native text revision", () => {
    expect(acknowledgeComposerNativeEvent(5, 4)).toBeNull();
  });

  it("rejects malformed revision counters", () => {
    expect(acknowledgeComposerNativeEvent(5, Number.NaN)).toBeNull();
    expect(acknowledgeComposerNativeEvent(5, 5.5)).toBeNull();
  });
});

describe("isComposerNativeEcho", () => {
  const snapshots = [{ eventCount: 3, value: "native", selection: { start: 6, end: 6 } }];

  it("matches the exact native text revision and selection", () => {
    expect(isComposerNativeEcho("native", { start: 6, end: 6 }, 3, snapshots)).toBe(true);
  });

  it("does not claim parent-driven selection or repeated-text updates", () => {
    expect(isComposerNativeEcho("native", { start: 2, end: 2 }, 3, snapshots)).toBe(false);
    expect(isComposerNativeEcho("native", { start: 6, end: 6 }, 4, snapshots)).toBe(false);
    expect(isComposerNativeEcho("parent edit", { start: 6, end: 6 }, 3, snapshots)).toBe(false);
  });

  it("matches value and revision when selection is uncontrolled", () => {
    expect(isComposerNativeEcho("native", null, 3, snapshots)).toBe(true);
  });
});

describe("resolveComposerControlledEventCount", () => {
  const snapshots = [
    { eventCount: 0, value: "", selection: { start: 0, end: 0 } },
    { eventCount: 2, value: "a", selection: { start: 1, end: 1 } },
    { eventCount: 4, value: "ab", selection: { start: 2, end: 2 } },
  ];

  it("tags a delayed parent value with the native revision that produced it", () => {
    expect(resolveComposerControlledEventCount("a", { start: 1, end: 1 }, 4, snapshots)).toBe(2);
  });

  it("does not acknowledge the pre-edit parent value as the latest revision", () => {
    expect(resolveComposerControlledEventCount("", { start: 0, end: 0 }, 4, snapshots)).toBe(0);
  });

  it("acknowledges the latest native value at the latest revision", () => {
    expect(resolveComposerControlledEventCount("ab", { start: 2, end: 2 }, 4, snapshots)).toBe(4);
  });

  it("allows an unmatched parent-driven edit at the latest native revision", () => {
    expect(resolveComposerControlledEventCount("/plan ", { start: 6, end: 6 }, 4, snapshots)).toBe(
      4,
    );
  });

  it("uses the newest revision when selection events repeat the same value", () => {
    expect(
      resolveComposerControlledEventCount("ab", { start: 1, end: 1 }, 5, [
        ...snapshots,
        { eventCount: 5, value: "ab", selection: { start: 1, end: 1 } },
      ]),
    ).toBe(5);
  });

  it("keeps a stale selection paired with current text behind the native revision", () => {
    expect(resolveComposerControlledEventCount("ab", { start: 1, end: 1 }, 4, snapshots)).toBe(3);
  });

  it("does not control selection when no selection prop is provided", () => {
    expect(resolveComposerControlledEventCount("ab", null, 4, snapshots)).toBe(4);
  });
});
