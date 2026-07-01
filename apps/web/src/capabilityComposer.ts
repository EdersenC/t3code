import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderSkill,
  T3CapabilitySnapshot,
  T3CapabilitySnapshotEntry,
} from "@t3tools/contracts";

function sourceLabel(capability: T3CapabilitySnapshotEntry): string {
  if (capability.source === "t3") return "T3";
  if (capability.providerDisplayName) return capability.providerDisplayName;
  if (capability.harnessName) return capability.harnessName;
  return capability.source === "provider-native" ? "Provider" : "Harness";
}

export function capabilityToProviderSkill(
  capability: T3CapabilitySnapshotEntry,
): ServerProviderSkill | null {
  if (capability.kind !== "skill" || !capability.enabled || capability.activation !== "on-demand") {
    return null;
  }
  return {
    name: capability.name,
    path: capability.path ?? capability.sourceDetail ?? capability.id,
    enabled: capability.enabled,
    scope: sourceLabel(capability),
    ...(capability.description ? { description: capability.description } : {}),
    ...(capability.displayName ? { displayName: capability.displayName } : {}),
    ...(capability.shortDescription ? { shortDescription: capability.shortDescription } : {}),
  };
}

export function effectiveComposerSkills(input: {
  readonly capabilities: T3CapabilitySnapshot | null | undefined;
  readonly selectedProviderStatus: ServerProvider | null | undefined;
}): ServerProviderSkill[] {
  const selectedProviderId = input.selectedProviderStatus?.instanceId;
  const fromCapabilities =
    input.capabilities?.capabilities
      .filter(
        (capability) =>
          capability.source === "t3" ||
          (capability.source === "provider-native" &&
            capability.providerInstanceId === selectedProviderId),
      )
      .map(capabilityToProviderSkill)
      .filter((skill): skill is ServerProviderSkill => skill !== null) ?? [];
  const byName = new Map<string, ServerProviderSkill>();
  for (const skill of fromCapabilities) {
    byName.set(skill.name, skill);
  }
  for (const skill of input.selectedProviderStatus?.skills ?? []) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

export function t3CommandCapabilities(input: {
  readonly capabilities: T3CapabilitySnapshot | null | undefined;
}): T3CapabilitySnapshotEntry[] {
  return (
    input.capabilities?.capabilities.filter(
      (capability) =>
        capability.source === "t3" &&
        capability.kind === "slash-command" &&
        capability.enabled &&
        capability.activation === "command",
    ) ?? []
  );
}

export function providerCommandCapabilities(input: {
  readonly capabilities: T3CapabilitySnapshot | null | undefined;
  readonly selectedProviderStatus: ServerProvider | null | undefined;
}): T3CapabilitySnapshotEntry[] {
  const selectedProviderId = input.selectedProviderStatus?.instanceId;
  return (
    input.capabilities?.capabilities.filter(
      (capability) =>
        capability.source === "provider-native" &&
        capability.kind === "slash-command" &&
        capability.enabled &&
        capability.activation === "command" &&
        capability.providerInstanceId === selectedProviderId,
    ) ?? []
  );
}

export function toolRegistryCapabilities(input: {
  readonly capabilities: T3CapabilitySnapshot | null | undefined;
}): T3CapabilitySnapshotEntry[] {
  return (
    input.capabilities?.capabilities.filter(
      (capability) =>
        (capability.kind === "tool" || capability.kind === "subagent") &&
        capability.activation !== "hidden",
    ) ?? []
  );
}

export function capabilitySourceDescription(
  capability: Pick<
    T3CapabilitySnapshotEntry,
    "description" | "shortDescription" | "sourceDetail" | "providerDisplayName" | "harnessName"
  >,
): string {
  return (
    capability.shortDescription ??
    capability.description ??
    capability.sourceDetail ??
    capability.providerDisplayName ??
    capability.harnessName ??
    "T3 capability"
  );
}

export function capabilityProviderKey(
  selectedProvider: ProviderDriverKind,
  capability: T3CapabilitySnapshotEntry,
): ProviderDriverKind {
  return capability.provider ?? selectedProvider;
}
