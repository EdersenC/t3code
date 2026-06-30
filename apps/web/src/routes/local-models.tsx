import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type LocalModelHubDownload,
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
  HashIcon,
  LayoutGridIcon,
  ListIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  SearchIcon,
  ServerIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const SEARCH_PRESETS: ReadonlyArray<{
  readonly source: LocalModelHubSource;
  readonly label: string;
  readonly query: string;
}> = [
  { source: "huggingface", label: "Qwen 4B", query: "Qwen/Qwen3-4B" },
  { source: "huggingface", label: "Qwen 8B", query: "Qwen/Qwen3-8B" },
  { source: "huggingface", label: "Qwen Coder", query: "Qwen/Qwen2.5-Coder" },
  { source: "huggingface", label: "GLM", query: "zai-org/GLM" },
  { source: "huggingface", label: "SmolLM", query: "HuggingFaceTB/SmolLM" },
  { source: "huggingface", label: "Tiny test", query: "sshleifer/tiny-gpt2" },
  { source: "ollama", label: "Qwen 3", query: "qwen3" },
  { source: "ollama", label: "GPT OSS", query: "gpt-oss" },
  { source: "ollama", label: "Llama 3.2", query: "llama3.2" },
  { source: "ollama", label: "Gemma 3", query: "gemma3" },
];

type ModelViewMode = "list" | "cards";
type DownloadStatus = LocalModelHubDownload["status"];

const HUGGING_FACE_METADATA_PATTERNS = [
  "*.json",
  "*.model",
  "*.txt",
  "*.py",
  "tokenizer*",
  "vocab*",
  "merges*",
] as const;

const DOWNLOAD_PROFILES: ReadonlyArray<{
  readonly label: string;
  readonly description: string;
  readonly includePatterns: ReadonlyArray<string>;
  readonly excludePatterns?: ReadonlyArray<string>;
}> = [
  { label: "Whole repo", description: "Everything", includePatterns: [] },
  {
    label: "Safetensors",
    description: "Weights + configs",
    includePatterns: ["*.safetensors", ...HUGGING_FACE_METADATA_PATTERNS],
  },
  { label: "GGUF", description: "llama.cpp", includePatterns: ["*.gguf", "*.json", "*.md"] },
  {
    label: "4-bit",
    description: "small VRAM",
    includePatterns: [
      "*q4*",
      "*Q4*",
      "*int4*",
      "*4bit*",
      "*4-bit*",
      "*nf4*",
      ...HUGGING_FACE_METADATA_PATTERNS,
    ],
  },
  {
    label: "8-bit",
    description: "balanced",
    includePatterns: [
      "*q8*",
      "*Q8*",
      "*int8*",
      "*8bit*",
      "*8-bit*",
      ...HUGGING_FACE_METADATA_PATTERNS,
    ],
  },
  {
    label: "16-bit",
    description: "training/full",
    includePatterns: ["*fp16*", "*bf16*", "*float16*", ...HUGGING_FACE_METADATA_PATTERNS],
  },
];

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

function formatDuration(startedAt: string, completedAt: string | undefined): string | null {
  const started = Date.parse(startedAt);
  const ended = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  const totalSeconds = Math.max(0, Math.round((ended - started) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function modelBadges(model: LocalModelHubModel): ReadonlyArray<string> {
  return [
    model.format !== "unknown" ? model.format : null,
    model.metadata.quantization ?? null,
    model.metadata.fileCount !== undefined ? `${model.metadata.fileCount} files` : null,
    ...model.metadata.tags.slice(0, 3),
  ].filter((item): item is string => Boolean(item && item.length > 0));
}

function sourceTone(source: LocalModelHubSource): string {
  return source === "huggingface"
    ? "border-sky-500/20 bg-sky-500/6 text-sky-700 dark:text-sky-300"
    : "border-emerald-500/20 bg-emerald-500/6 text-emerald-700 dark:text-emerald-300";
}

function isActiveDownloadStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

function isTerminalDownloadStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function localModelSourceLabel(source: LocalModelHubSource): string {
  return source === "huggingface" ? "Hugging Face" : "Ollama";
}

function downloadProfileDescription(profileLabel: string | undefined): string {
  return profileLabel && profileLabel.length > 0 ? ` (${profileLabel})` : "";
}

function downloadStartedDescription(input: {
  readonly modelId: string;
  readonly source: LocalModelHubSource;
  readonly profileLabel?: string | undefined;
  readonly targetPath: string;
}): string {
  return `${input.modelId}${downloadProfileDescription(input.profileLabel)} is downloading from ${localModelSourceLabel(input.source)} into ${input.targetPath}.`;
}

function terminalDownloadToast(download: LocalModelHubDownload) {
  const duration = formatDuration(download.startedAt, download.completedAt);
  const durationText = duration ? ` in ${duration}` : "";
  if (download.status === "completed") {
    return stackedThreadToast({
      type: "success",
      title: "Model download completed",
      description: `${download.modelId} finished downloading${durationText}.`,
      data: { dismissAfterVisibleMs: 6_000 },
    });
  }
  if (download.status === "cancelled") {
    return stackedThreadToast({
      type: "warning",
      title: "Model download cancelled",
      description: `${download.modelId} was cancelled${durationText}.`,
      data: { dismissAfterVisibleMs: 6_000 },
    });
  }
  if (download.status === "failed") {
    const detail = download.detail ?? "The download failed.";
    const logs = download.logTail.length > 0 ? download.logTail.slice(-12).join("\n") : null;
    return stackedThreadToast({
      type: "error",
      title: "Model download failed",
      description: `${download.modelId}: ${detail}`,
      data: {
        expandableContent: logs ? (
          <pre className="whitespace-pre-wrap text-[11px] leading-4">{logs}</pre>
        ) : undefined,
        expandableLabels: { expand: "Show download log", collapse: "Hide download log" },
      },
    });
  }
  return null;
}

function ModelStatChips({ model }: { readonly model: LocalModelHubModel }) {
  const size = formatBytes(model.metadata.totalSizeBytes ?? model.sizeBytes);
  return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-2">
      <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 text-xs font-semibold text-sky-800 dark:text-sky-200">
        <HardDriveIcon className="size-3.5 shrink-0" />
        <span className="text-[10px] font-medium text-sky-700/80 dark:text-sky-200/80">Size</span>
        <span className="truncate">{size}</span>
      </span>
      {model.metadata.parameterCount ? (
        <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-amber-500/35 bg-amber-500/12 px-2.5 text-xs font-semibold text-amber-900 dark:text-amber-100">
          <HashIcon className="size-3.5 shrink-0" />
          <span className="text-[10px] font-medium text-amber-800/80 dark:text-amber-100/80">
            Params
          </span>
          <span className="truncate">{model.metadata.parameterCount}</span>
        </span>
      ) : null}
    </div>
  );
}

function ModelSummary({ model }: { readonly model: LocalModelHubModel }) {
  const badges = modelBadges(model);
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{model.modelId}</span>
        <Badge size="sm" variant={model.installed ? "success" : "outline"}>
          {model.installed ? "Installed" : "Remote"}
        </Badge>
        <Badge size="sm" variant="outline" className={cn("capitalize", sourceTone(model.source))}>
          {model.source === "huggingface" ? "HF" : "Ollama"}
        </Badge>
      </div>
      <ModelStatChips model={model} />
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
    </>
  );
}

function ModelRow({
  model,
  action,
}: {
  readonly model: LocalModelHubModel;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/70 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <ModelSummary model={model} />
      </div>
      {action ? <div className="flex items-center">{action}</div> : null}
    </div>
  );
}

function ModelCard({
  model,
  action,
}: {
  readonly model: LocalModelHubModel;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-36 flex-col justify-between gap-4 rounded-md border border-border bg-background p-4">
      <div className="min-w-0">
        <ModelSummary model={model} />
      </div>
      {action ? <div className="flex justify-end">{action}</div> : null}
    </div>
  );
}

function ModelCollection({
  models,
  viewMode,
  empty,
  renderAction,
}: {
  readonly models: ReadonlyArray<LocalModelHubModel>;
  readonly viewMode: ModelViewMode;
  readonly empty: string;
  readonly renderAction?: (model: LocalModelHubModel) => React.ReactNode;
}) {
  if (models.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{empty}</div>;
  }
  if (viewMode === "cards") {
    return (
      <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
        {models.map((model) => (
          <ModelCard
            key={`${model.source}:${model.modelId}`}
            model={model}
            action={renderAction?.(model)}
          />
        ))}
      </div>
    );
  }
  return (
    <>
      {models.map((model) => (
        <ModelRow
          key={`${model.source}:${model.modelId}`}
          model={model}
          action={renderAction?.(model)}
        />
      ))}
    </>
  );
}

function ModelDownloadActions({
  model,
  onDownload,
}: {
  readonly model: LocalModelHubModel;
  readonly onDownload: (
    model: LocalModelHubModel,
    options?: {
      readonly includePatterns?: ReadonlyArray<string>;
      readonly excludePatterns?: ReadonlyArray<string>;
      readonly profileLabel?: string;
    },
  ) => void;
}) {
  if (model.source === "ollama") {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={model.installed}
        onClick={() => onDownload(model)}
      >
        <DownloadIcon className="size-3.5" />
        Pull
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {DOWNLOAD_PROFILES.map((profile) => (
        <Button
          key={profile.label}
          size="xs"
          variant={profile.label === "Whole repo" ? "outline" : "secondary"}
          title={profile.description}
          onClick={() =>
            onDownload(model, {
              includePatterns: profile.includePatterns,
              ...(profile.excludePatterns ? { excludePatterns: profile.excludePatterns } : {}),
              profileLabel: profile.label,
            })
          }
        >
          <DownloadIcon className="size-3.5" />
          {profile.label}
        </Button>
      ))}
    </div>
  );
}

function LocalModelsPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useAtomValue(primaryServerSettingsAtom);
  const [selectedSource, setSelectedSource] = useState<LocalModelHubSource>("huggingface");
  const [query, setQuery] = useState("Qwen/Qwen3");
  const [modelViewMode, setModelViewMode] = useState<ModelViewMode>("list");
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
  const downloadStatusByIdRef = useRef<ReadonlyMap<string, DownloadStatus>>(new Map());
  const didInitializeDownloadToastWatcherRef = useRef(false);

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

  useEffect(() => {
    const previousStatuses = downloadStatusByIdRef.current;
    const nextStatuses = new Map(
      downloads.map((download) => [download.downloadId, download.status]),
    );
    if (!didInitializeDownloadToastWatcherRef.current) {
      didInitializeDownloadToastWatcherRef.current = true;
      downloadStatusByIdRef.current = nextStatuses;
      return;
    }
    for (const download of downloads) {
      const previousStatus = previousStatuses.get(download.downloadId);
      if (
        previousStatus === undefined ||
        previousStatus === download.status ||
        !isActiveDownloadStatus(previousStatus) ||
        !isTerminalDownloadStatus(download.status)
      ) {
        continue;
      }
      const toast = terminalDownloadToast(download);
      if (toast) toastManager.add(toast);
    }
    downloadStatusByIdRef.current = nextStatuses;
  }, [downloads]);

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

  const handleSearchRequest = useCallback(
    async (input: { readonly source: LocalModelHubSource; readonly query: string }) => {
      if (primaryEnvironmentId === null || input.query.trim().length === 0) return;
      const trimmedQuery = input.query.trim();
      setSelectedSource(input.source);
      setQuery(trimmedQuery);
      setIsSearching(true);
      const result = await runSearch({
        environmentId: primaryEnvironmentId,
        input: {
          source: input.source,
          query: trimmedQuery,
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
    },
    [primaryEnvironmentId, runSearch],
  );

  const handleSearch = useCallback(async () => {
    if (query.trim().length === 0) return;
    await handleSearchRequest({ source: selectedSource, query });
  }, [handleSearchRequest, query, selectedSource]);

  const handlePresetSearch = useCallback(
    async (preset: (typeof SEARCH_PRESETS)[number]) => {
      await handleSearchRequest({ source: preset.source, query: preset.query });
    },
    [handleSearchRequest],
  );

  const handleDownload = useCallback(
    async (
      model: LocalModelHubModel,
      options?: {
        readonly includePatterns?: ReadonlyArray<string>;
        readonly excludePatterns?: ReadonlyArray<string>;
        readonly profileLabel?: string;
      },
    ) => {
      if (primaryEnvironmentId === null) return;
      const result = await startDownload({
        environmentId: primaryEnvironmentId,
        input: {
          source: model.source,
          modelId: model.modelId,
          includePatterns: options?.includePatterns ?? [],
          excludePatterns: options?.excludePatterns ?? [],
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
      if (result._tag === "Success") {
        const download = result.value.download;
        toastManager.add(
          stackedThreadToast({
            type: isActiveDownloadStatus(download.status) ? "loading" : "info",
            title: isActiveDownloadStatus(download.status)
              ? "Model download started"
              : "Model download requested",
            description: downloadStartedDescription({
              modelId: download.modelId,
              source: download.source,
              profileLabel: options?.profileLabel,
              targetPath: download.targetPath,
            }),
            data: { dismissAfterVisibleMs: 4_000 },
          }),
        );
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
      if (result._tag === "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Download cancellation requested",
            description: `${result.value.download.modelId} is being cancelled.`,
            data: { dismissAfterVisibleMs: 4_000 },
          }),
        );
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
                  <div className="grid gap-3 border-b border-border bg-muted/20 p-3">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
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
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <SparklesIcon className="size-3.5 text-muted-foreground" />
                      {SEARCH_PRESETS.map((preset) => (
                        <Button
                          key={`${preset.source}:${preset.query}`}
                          size="xs"
                          variant={preset.source === selectedSource ? "secondary" : "outline"}
                          onClick={() => void handlePresetSearch(preset)}
                        >
                          {preset.label}
                        </Button>
                      ))}
                      <div className="ms-auto flex rounded-md border border-border bg-background p-0.5">
                        <Button
                          size="icon-xs"
                          variant={modelViewMode === "list" ? "secondary" : "ghost"}
                          title="List view"
                          onClick={() => setModelViewMode("list")}
                        >
                          <ListIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant={modelViewMode === "cards" ? "secondary" : "ghost"}
                          title="Card view"
                          onClick={() => setModelViewMode("cards")}
                        >
                          <LayoutGridIcon className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="divide-y divide-border/70">
                    <ModelCollection
                      models={activeSearchModels}
                      viewMode={modelViewMode}
                      empty={isSearching ? "Searching..." : "No search results"}
                      renderAction={(model) => (
                        <ModelDownloadActions
                          model={model}
                          onDownload={(downloadModel, options) =>
                            void handleDownload(downloadModel, options)
                          }
                        />
                      )}
                    />
                  </div>
                </section>

                <section className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-3">
                    <HardDriveIcon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Installed</span>
                  </div>
                  <ModelCollection
                    models={installedForSource}
                    viewMode={modelViewMode}
                    empty="No installed models"
                  />
                </section>

                <section className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-3">
                    <DownloadIcon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Downloads</span>
                  </div>
                  {downloads.length > 0 ? (
                    downloads.map((download) => {
                      const active = isActiveDownloadStatus(download.status);
                      const duration = formatDuration(download.startedAt, download.completedAt);
                      return (
                        <div
                          key={download.downloadId}
                          className={cn(
                            "grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]",
                            active ? "bg-info/4" : "",
                          )}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              {active ? (
                                <LoaderCircleIcon className="size-4 animate-spin text-info" />
                              ) : null}
                              <span className="truncate text-sm font-medium">
                                {download.modelId}
                              </span>
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
                              {duration ? (
                                <span className="text-xs text-muted-foreground">
                                  {active ? `${duration} elapsed` : `completed in ${duration}`}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 truncate text-xs text-muted-foreground">
                              {download.progress ?? download.detail ?? download.targetPath}
                            </div>
                            {active ? (
                              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                                <div className="h-full w-1/3 animate-pulse rounded-full bg-info" />
                              </div>
                            ) : null}
                            {download.logTail.length > 0 ? (
                              <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-4 text-muted-foreground">
                                {download.logTail.slice(-6).join("\n")}
                              </pre>
                            ) : null}
                          </div>
                          {active ? (
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
                      );
                    })
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
