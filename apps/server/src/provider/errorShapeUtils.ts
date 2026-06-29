export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function detailFromKnownErrorShape(error: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (!isRecord(error)) {
    return undefined;
  }

  const direct =
    stringField(error, "message") ??
    stringField(error, "detail") ??
    stringField(error, "error") ??
    stringField(error, "reason") ??
    stringField(error, "statusText");
  if (direct) return direct;

  for (const field of ["data", "body", "response", "cause", "error", "details", "info"]) {
    const nested = detailFromKnownErrorShape(error[field], depth + 1);
    if (nested) return nested;
  }

  return undefined;
}
