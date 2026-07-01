import type { OpenCodeCapabilityRuntime } from "../capabilities/T3CapabilityRegistry.ts";

export interface OpenCodeCapabilityConfigInput {
  readonly capabilityRuntime?: Pick<OpenCodeCapabilityRuntime, "skillPaths" | "skillPermissions">;
}

export function openCodeCapabilityConfigFragment(input: OpenCodeCapabilityConfigInput): {
  readonly skills?: { readonly paths: ReadonlyArray<string> };
  readonly permission?: { readonly skill: Readonly<Record<string, "allow" | "deny">> };
} {
  const skillPaths = input.capabilityRuntime?.skillPaths ?? [];
  const skillPermissions = input.capabilityRuntime?.skillPermissions ?? {};
  return {
    ...(skillPaths.length > 0 ? { skills: { paths: skillPaths } } : {}),
    ...(Object.keys(skillPermissions).length > 0
      ? { permission: { skill: skillPermissions } }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function mergeOpenCodeCapabilityConfigContent(
  configContent: string | undefined,
  capabilityRuntime: OpenCodeCapabilityConfigInput["capabilityRuntime"] | undefined,
): string | undefined {
  if (capabilityRuntime === undefined) return configContent;
  const fragment = openCodeCapabilityConfigFragment({ capabilityRuntime });
  if (fragment.skills === undefined && fragment.permission === undefined) return configContent;

  let base: unknown = {};
  if (configContent && configContent.trim().length > 0) {
    try {
      base = JSON.parse(configContent);
    } catch {
      return configContent;
    }
  }
  const baseConfig = asRecord(base);
  const baseSkills = asRecord(baseConfig.skills);
  const basePermission = asRecord(baseConfig.permission);
  const baseSkillPermission = asRecord(basePermission.skill);
  const mergedSkillPaths = [
    ...new Set([
      ...((Array.isArray(baseSkills.paths) ? baseSkills.paths : []) as Array<string>),
      ...(fragment.skills?.paths ?? []),
    ]),
  ];

  return JSON.stringify({
    ...baseConfig,
    ...(fragment.skills
      ? {
          skills: {
            ...baseSkills,
            paths: mergedSkillPaths,
          },
        }
      : {}),
    ...(fragment.permission
      ? {
          permission: {
            ...basePermission,
            skill: {
              ...baseSkillPermission,
              ...fragment.permission.skill,
            },
          },
        }
      : {}),
  });
}
