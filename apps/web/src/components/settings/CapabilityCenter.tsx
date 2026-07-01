import type {
  T3CapabilityActivation,
  T3CapabilitySnapshotEntry,
  UnifiedSettings,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { BotIcon, WrenchIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { toolRegistryCapabilities } from "../../capabilityComposer";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerConfigAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function activationOptionsForKind(
  kind: T3CapabilitySnapshotEntry["kind"],
): ReadonlyArray<T3CapabilityActivation> {
  switch (kind) {
    case "skill":
      return ["preload", "on-demand", "hidden"];
    case "slash-command":
      return ["command", "hidden"];
    case "tool":
    case "subagent":
      return ["on-demand", "hidden"];
  }
}

interface CapabilityCenterProps {
  readonly title?: string;
  readonly icon?: ReactNode;
}

function Badge({
  children,
  tone = "neutral",
}: {
  readonly children: string;
  readonly tone?: "neutral" | "t3" | "provider" | "harness";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm border px-1.5 font-medium text-[0.6875rem]",
        tone === "t3" && "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        tone === "provider" &&
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "harness" &&
          "border-amber-500/24 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "neutral" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function sourceTone(source: T3CapabilitySnapshotEntry["source"]): "t3" | "provider" | "harness" {
  if (source === "t3") return "t3";
  if (source === "provider-native") return "provider";
  return "harness";
}

function sourceLabel(capability: T3CapabilitySnapshotEntry): string {
  if (capability.source === "t3") return "T3";
  if (capability.providerDisplayName) return capability.providerDisplayName;
  if (capability.harnessName) return capability.harnessName;
  return capability.source === "provider-native" ? "Provider" : "Harness";
}

function sourceDetail(capability: T3CapabilitySnapshotEntry): string {
  return (
    capability.sourceDetail ??
    capability.path ??
    capability.providerInstanceId ??
    capability.harnessName ??
    "built-in"
  );
}

function updateCapabilityOverride(input: {
  readonly settings: UnifiedSettings;
  readonly capabilityId: string;
  readonly patch: { readonly enabled?: boolean; readonly activation?: T3CapabilityActivation };
}): UnifiedSettings["capabilityRegistry"] {
  const current = input.settings.capabilityRegistry;
  return {
    ...current,
    overrides: {
      ...current.overrides,
      [input.capabilityId]: {
        ...current.overrides[input.capabilityId],
        ...input.patch,
      },
    },
  };
}

function CapabilityRow({
  capability,
  settings,
  onUpdateCapabilityRegistry,
}: {
  readonly capability: T3CapabilitySnapshotEntry;
  readonly settings: UnifiedSettings;
  readonly onUpdateCapabilityRegistry: (registry: UnifiedSettings["capabilityRegistry"]) => void;
}) {
  const editable = capability.source === "t3";
  const label = capability.displayName ?? capability.name;
  const activationOptions = activationOptionsForKind(capability.kind);

  return (
    <TableRow>
      <TableCell className="min-w-48 whitespace-normal">
        <div className="space-y-1">
          <div className="font-medium text-foreground">{label}</div>
          <div className="text-muted-foreground">
            {capability.description ?? capability.shortDescription}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge>{capability.kind}</Badge>
      </TableCell>
      <TableCell>
        {editable ? (
          <Select
            value={capability.activation}
            onValueChange={(activation) =>
              onUpdateCapabilityRegistry(
                updateCapabilityOverride({
                  settings,
                  capabilityId: capability.id,
                  patch: { activation: activation as T3CapabilityActivation },
                }),
              )
            }
          >
            <SelectTrigger size="xs" className="w-28 min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {activationOptions.map((activation) => (
                <SelectItem key={activation} value={activation}>
                  {activation}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <Badge>{capability.activation}</Badge>
        )}
      </TableCell>
      <TableCell>
        <Badge tone={sourceTone(capability.source)}>{capability.source}</Badge>
      </TableCell>
      <TableCell className="max-w-40 truncate">{sourceLabel(capability)}</TableCell>
      <TableCell>
        {editable ? (
          <Switch
            checked={capability.enabled}
            aria-label={`Toggle ${label}`}
            onCheckedChange={(enabled) =>
              onUpdateCapabilityRegistry(
                updateCapabilityOverride({
                  settings,
                  capabilityId: capability.id,
                  patch: { enabled: Boolean(enabled) },
                }),
              )
            }
          />
        ) : (
          <Badge>{capability.enabled ? "enabled" : "disabled"}</Badge>
        )}
      </TableCell>
      <TableCell className="max-w-64 truncate font-mono text-muted-foreground">
        {sourceDetail(capability)}
      </TableCell>
    </TableRow>
  );
}

export function CapabilityCenter({ title, icon }: CapabilityCenterProps = {}) {
  const config = useAtomValue(primaryServerConfigAtom);
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const capabilities = useMemo(
    () => config?.capabilities.capabilities ?? [],
    [config?.capabilities.capabilities],
  );
  const tools = useMemo(
    () => toolRegistryCapabilities({ capabilities: { capabilities } }),
    [capabilities],
  );
  const counts = useMemo(
    () => ({
      tools: tools.length,
    }),
    [tools.length],
  );

  return (
    <SettingsPageContainer className="max-w-6xl">
      <SettingsSection
        title={title ?? "Subagent"}
        icon={icon ?? <WrenchIcon className="size-3.5" />}
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Badge>{`Subagent ${String(counts.tools)}`}</Badge>
          </div>
        }
      >
        {tools.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-8 text-sm text-muted-foreground">
            <BotIcon className="size-4" />
            No subagent tools are available from this environment yet.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Activation</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((capability) => (
                <CapabilityRow
                  key={capability.id}
                  capability={capability}
                  settings={settings}
                  onUpdateCapabilityRegistry={(capabilityRegistry) =>
                    updateSettings({ capabilityRegistry })
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
