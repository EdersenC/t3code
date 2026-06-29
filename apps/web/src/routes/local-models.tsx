import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type LocalModelHubModel,
  type LocalModelHubSearchResult,
  type LocalModelHubSource,
} from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  BoxesIcon,
  CloudIcon,
  DownloadIcon,
  HardDriveIcon,
  RefreshCcwIcon,
  SearchIcon,
  ServerIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SidebarInset } from "~/components/ui/sidebar";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useAtomValue } from "@effect/atom-react";

const SOURCES: ReadonlyArray<{
  readonly source: LocalModelHubSource;
  readonly label: string;
  readonly icon: typeof BoxesIcon;
}> = [
  { source: "huggingface", label: "Hugging Face", icon: BoxesIcon },
  { source: "ollama", label: "Ollama", icon: ServerIcon },
];

const PLACEHOLDER_SOURCES = [
  "GGUF folders",
  "SGLang",
  "TGI",
  "LM Studio",
  "OpenRouter cache",
] as const;

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function modelBadges(model: LocalModelHubModel): ReadonlyArray<string> {
  return [
    model.format !== "unknown" ? model.format : null,
    model.metadata.parameterCount ?? null,
    model.metadata.quantization ?? null,
    ...model.metadata.tags.slice(0, 3),
  ].filter((item): item is string => Boolean(item && item.length > 0));
}

function sourceTone(source: LocalModelHubSource): string {
  return source === "huggingface"
    ? "border-sky-500/20 bg-sky-500/6 text-sky-700 dark:text-sky-300"
    : "border-emerald-500/20 bg-emerald-500/6 text-emerald-700 dark:text-emerald-300";
}

function ModelRow({
  model,
  action,
}: {
  readonly model: LocalModelHubModel;
  readonly action?: React.ReactNode;
}) {
  const badges = modelBadges(model);
  return (
    <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/70 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{model.modelId}</span>
          <Badge size="sm" variant={model.installed ? "success" : "outline"}>
            {model.installed ? "Installed" : "Remote"}
          </Badge>
          <Badge size="sm" variant="outline" className={cn("capitalize", sourceTone(model.source))}>
            {model.source === "huggingface" ? "HF" : "Ollama"}
          </Badge>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatBytes(model.sizeBytes)}</span>
          {model.metadata.downloads !== undefined ? (
            <span>{model.metadata.downloads} downloads</span>
          ) : null}
          {model.metadata.likes !== undefined ? <span>{model.metadata.likes} likes</span> : null}
          {model.localPath ? <span className="truncate">{model.localPath}</span> : null}
        </div>
        {badges.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <Badge key={badge} size="sm" variant="secondary">
                {badge}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      {action ? <div className="flex items-center">{action}</div> : null}
    </div>
  );
}

function LocalModelsPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useAtomValue(primaryServerSettingsAtom);
  const [selectedSource, setSelectedSource] = useState<LocalModelHubSource>("huggingface");
  const [query, setQuery] = useState("Qwen/Qwen3");
  const [rootDraft, setRootDraft] = useState(settings.localModelHub.modelRoot);
  const [searchResult, setSearchResult] = useState<LocalModelHubSearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const snapshotQuery = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : serverEnvironment.localModelHubSnapshot({
          environmentId: primaryEnvironmentId,
          input: {},
        }),
  );
  const runSearch = useAtomQueryRunner(serverEnvironment.localModelHubSearch, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const startDownload = useAtomCommand(serverEnvironment.localModelHubStartDownload, {
    reportFailure: false,
  });
  const cancelDownload = useAtomCommand(serverEnvironment.localModelHubCancelDownload, {
    reportFailure: false,
  });

  useEffect(() => {
    setRootDraft(settings.localModelHub.modelRoot);
  }, [settings.localModelHub.modelRoot]);

  const installedModels = snapshotQuery.data?.models ?? [];
  const installedForSource = installedModels.filter((model) => model.source === selectedSource);
  const downloads = snapshotQuery.data?.downloads ?? [];
  const hasActiveDownloads = downloads.some(
    (download) => download.status === "queued" || download.status === "running",
  );
  const sourceDescriptors = snapshotQuery.data?.sources ?? [];
  const activeSearchModels =
    searchResult?.source === selectedSource && searchResult.query === query.trim()
      ? searchResult.models
      : [];

  useEffect(() => {
    if (!hasActiveDownloads) return;
    const interval = window.setInterval(() => {
      snapshotQuery.refresh();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [hasActiveDownloads, snapshotQuery]);

  const handleSaveRoot = useCallback(async () => {
    if (primaryEnvironmentId === null) return;
    const result = await updateSettings({
      environmentId: primaryEnvironmentId,
      input: { patch: { localModelHub: { modelRoot: rootDraft } } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Model root was not saved",
          description: error instanceof Error ? error.message : "The settings update failed.",
        }),
      );
      return;
    }
    snapshotQuery.refresh();
  }, [primaryEnvironmentId, rootDraft, snapshotQuery, updateSettings]);

  const handleSearch = useCallback(async () => {
    if (primaryEnvironmentId === null || query.trim().length === 0) return;
    setIsSearching(true);
    const result = await runSearch({
      environmentId: primaryEnvironmentId,
      input: {
        source: selectedSource,
        query: query.trim(),
        limit: 16,
      },
    });
    setIsSearching(false);
    if (result._tag === "Success") {
      setSearchResult(result.value);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Model search failed",
          description: error instanceof Error ? error.message : "The search request failed.",
        }),
      );
    }
  }, [primaryEnvironmentId, query, runSearch, selectedSource]);

  const handleDownload = useCallback(
    async (model: LocalModelHubModel) => {
      if (primaryEnvironmentId === null) return;
      const result = await startDownload({
        environmentId: primaryEnvironmentId,
        input: {
          source: model.source,
          modelId: model.modelId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Download did not start",
            description: error instanceof Error ? error.message : "The download request failed.",
          }),
        );
        return;
      }
      snapshotQuery.refresh();
    },
    [primaryEnvironmentId, snapshotQuery, startDownload],
  );

  const handleCancelDownload = useCallback(
    async (downloadId: string) => {
      if (primaryEnvironmentId === null) return;
      const result = await cancelDownload({
        environmentId: primaryEnvironmentId,
        input: { downloadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Download was not cancelled",
            description: error instanceof Error ? error.message : "The cancel request failed.",
          }),
        );
        return;
      }
      snapshotQuery.refresh();
    },
    [cancelDownload, primaryEnvironmentId, snapshotQuery],
  );

  const countsBySource = useMemo(
    () =>
      new Map(
        SOURCES.map(({ source }) => [
          source,
          installedModels.filter((model) => model.source === source).length,
        ]),
      ),
    [installedModels],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <header
          className={cn(
            "shrink-0 border-b border-border bg-background/95 px-4 py-3 transition-[padding-left] duration-200 ease-linear sm:px-6",
            isElectron
              ? "drag-region h-[52px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
              : COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-7 items-center gap-3">
            <HardDriveIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Models</span>
            <Badge size="sm" variant="outline" className="ms-auto">
              {installedModels.length} installed
            </Badge>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
            <section className="grid gap-3 border-b border-border pb-5 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="model-root">
                  Model root
                </label>
                <div className="flex min-w-0 gap-2">
                  <Input
                    id="model-root"
                    value={rootDraft}
                    placeholder={snapshotQuery.data?.defaultModelRoot ?? "App managed model root"}
                    onChange={(event) => setRootDraft(event.target.value)}
                  />
                  <Button size="sm" variant="outline" onClick={() => void handleSaveRoot()}>
                    Save
                  </Button>
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={snapshotQuery.refresh}>
                <RefreshCcwIcon className="size-4" />
                Refresh
              </Button>
            </section>

            {snapshotQuery.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-foreground">
                {snapshotQuery.error}
              </div>
            ) : null}

            <section className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
              <div className="space-y-2">
                {SOURCES.map(({ source, label, icon: Icon }) => {
                  const selected = selectedSource === source;
                  const descriptor = sourceDescriptors.find((item) => item.source === source);
                  return (
                    <button
                      key={source}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                        selected
                          ? "border-primary/35 bg-primary/6 text-foreground"
                          : "border-border bg-background hover:bg-accent/50",
                      )}
                      onClick={() => setSelectedSource(source)}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {descriptor?.status ?? "ready"} · {countsBySource.get(source) ?? 0}
                        </span>
                      </span>
                    </button>
                  );
                })}
                <div className="grid gap-1 pt-2">
                  {PLACEHOLDER_SOURCES.map((label) => (
                    <div
                      key={label}
                      className="flex h-9 items-center gap-2 rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground/70"
                    >
                      <CloudIcon className="size-3.5" />
                      <span className="truncate">{label}</span>
                      <Badge size="sm" variant="outline" className="ms-auto">
                        Later
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>

              <div className="min-w-0 space-y-5">
                <section className="overflow-hidden rounded-md border border-border">
                  <div className="grid gap-2 border-b border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="relative min-w-0">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="pl-8"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void handleSearch();
                        }}
                      />
                    </div>
                    <Button size="sm" onClick={() => void handleSearch()} disabled={isSearching}>
                      <SearchIcon className="size-4" />
                      Search
                    </Button>
                  </div>
                  <div className="divide-y divide-border/70">
                    {activeSearchModels.length > 0 ? (
                      activeSearchModels.map((model) => (
                        <ModelRow
                          key={`${model.source}:${model.modelId}`}
                          model={model}
                          action={
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={model.installed}
                              onClick={() => void handleDownload(model)}
                            >
                              <DownloadIcon className="size-3.5" />
                              Download
                            </Button>
                          }
                        />
                      ))
                    ) : (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                        {isSearching ? "Searching..." : "No search results"}
                      </div>
                    )}
                  </div>
                </section>

                <section className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-3">
                    <HardDriveIcon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Installed</span>
                  </div>
                  {installedForSource.length > 0 ? (
                    installedForSource.map((model) => (
                      <ModelRow key={`${model.source}:${model.modelId}`} model={model} />
                    ))
                  ) : (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No installed models
                    </div>
                  )}
                </section>

                <section className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-3">
                    <DownloadIcon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Downloads</span>
                  </div>
                  {downloads.length > 0 ? (
                    downloads.map((download) => (
                      <div
                        key={download.downloadId}
                        className="grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">{download.modelId}</span>
                            <Badge
                              size="sm"
                              variant={
                                download.status === "completed"
                                  ? "success"
                                  : download.status === "failed"
                                    ? "error"
                                    : download.status === "cancelled"
                                      ? "warning"
                                      : "info"
                              }
                            >
                              {download.status}
                            </Badge>
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {download.progress ?? download.detail ?? download.targetPath}
                          </div>
                          {download.logTail.length > 0 ? (
                            <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-4 text-muted-foreground">
                              {download.logTail.slice(-6).join("\n")}
                            </pre>
                          ) : null}
                        </div>
                        {download.status === "running" || download.status === "queued" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => void handleCancelDownload(download.downloadId)}
                          >
                            <XIcon className="size-3.5" />
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No downloads
                    </div>
                  )}
                </section>
              </div>
            </section>
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/local-models")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: LocalModelsPage,
});
