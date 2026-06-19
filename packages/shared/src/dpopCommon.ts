import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DpopPublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String.check(Schema.isNonEmpty()),
  y: Schema.String.check(Schema.isNonEmpty()),
});
export type DpopPublicJwk = typeof DpopPublicJwk.Type;

export function normalizeDpopHtuOption(url: string): Option.Option<string> {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return Option.some(parsed.toString());
  } catch {
    return Option.none();
  }
}

export function normalizeDpopHtu(url: string): string | null {
  return Option.getOrNull(normalizeDpopHtuOption(url));
}
