import { describe, expect, it } from "vite-plus/test";

import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";

describe("OpenCode runtime permissions", () => {
  it("includes T3 skill permission policy in generated rules", () => {
    expect(
      buildOpenCodePermissionRules("full-access", {
        skillPermissions: {
          "customize-opencode": "allow",
          "legacy-hidden-skill": "deny",
        },
      }),
    ).toEqual([
      { permission: "skill", pattern: "customize-opencode", action: "allow" },
      { permission: "skill", pattern: "legacy-hidden-skill", action: "deny" },
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });
});
