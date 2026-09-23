import { deriveBackgroundSubagentTitle, formatSteerPrompt } from "./background-work.js";

export interface SubagentLineage {
  readonly parentRequestId?: string;
  readonly parentAgentToolCallId?: string;
  readonly [key: string]: unknown;
}

export interface SubagentDispatchMeta {
  readonly toolCallId: string;
  readonly lineage?: SubagentLineage;
}

export function computeSubagentRequestId(toolCallId: string): string {
  return toolCallId.length > 0 ? `subagent:${toolCallId}` : "subagent";
}

export function subagentSteerRunOptions(meta: SubagentDispatchMeta): {
  readonly inferenceRequestId: string;
  readonly lineage?: SubagentLineage;
} {
  const parentToolCallPart = meta.toolCallId.length > 0
    ? { parentAgentToolCallId: meta.toolCallId }
    : {};
  return {
    inferenceRequestId: computeSubagentRequestId(meta.toolCallId),
    ...(meta.lineage == null
      ? {}
      : { lineage: { ...meta.lineage, ...parentToolCallPart } }),
  };
}

export interface SubagentRunResult {
  readonly text: string;
  readonly aborted: boolean;
}

export interface ComputerUseUsageSnapshot {
  readonly modelId?: string;
  readonly turnEndedCount: number;
  readonly usage?: unknown;
}

export interface SubagentRunOptions {
  readonly inferenceRequestId?: string;
  readonly lineage?: SubagentLineage;
  readonly selectedVideos?: readonly unknown[];
}

export interface SubagentSession {
  run(prompt: string, options?: SubagentRunOptions): Promise<SubagentRunResult>;
  interrupt(reason: string): void;
  getResolvedOutline(): Promise<readonly unknown[]>;
  getObservedToolCallCount(): number;
  getActivitySnapshot(): readonly string[];
  getTranscriptPath(): string | null;
  getComputerUseUsageSnapshot?(): ComputerUseUsageSnapshot | undefined;
  getComputerUseAuditActionCounts?(): ReadonlyMap<string, number>;
}

export interface SubagentRecord {
  readonly subagentType: string;
  readonly title: string;
  readonly startedAtMs: number;
  status: "running" | "done" | "error" | "aborted";
}

export interface BackgroundSubagentCompletion {
  readonly parentAgentId: string;
  readonly subagentAgentId: string;
  readonly subagentType: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly status: "completed" | "error";
  readonly result: string;
  readonly quietOrigin?: string;
}

export interface RunningSubagentInfo {
  readonly subagentId: string;
  readonly subagentType: string;
  readonly title: string;
  readonly elapsedMs: number;
  readonly toolCallCount: number;
  readonly recentActivity: readonly string[];
  readonly transcriptPath: string | null;
}

export interface SubagentRuntimeHost {
  getConversationId(): string;
  resolveBoxId(): string;
  emitAsyncTasksChanged(): void;
  computerUse: { freeWindow(subagentAgentId: string): void };
  now?: () => number;
  onPendingWakeArmed?(event: {
    parentAgentId: string;
    kind: "subagent";
    workId: string;
    title: string;
    subagentType: string;
    quietOrigin?: string;
  }): void;
  onPendingWakeDisarmed?(event: {
    parentAgentId: string;
    kind: "subagent";
    workId: string;
  }): void;
  onComputerUseUsage?(event: {
    parentAgentId: string;
    subagentAgentId: string;
    subagentType: string;
    subagentRequestId: string;
    modelId?: string;
    outcome: "completed" | "error" | "aborted";
    durationMs: number;
    toolCallCount: number;
    turnEndedCount: number;
    usage?: unknown;
  }): void;
  actionAuditor?: { record(record: unknown): void };
  isComputerUseSubagentType?: (subagentType: string) => boolean;
  log?: (message: string) => void;
}

interface DispatchParams {
  readonly subagentAgentId: string;
  readonly subagentType: string;
  readonly toolCallId: string;
  readonly prompt: string;
  readonly run: () => Promise<SubagentRunResult>;
  readonly lineage?: SubagentLineage;
  readonly quietOrigin?: string;
}

export type SubagentRunOutcome =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "aborted" }
  | { readonly status: "error"; readonly error: string };

interface RuntimeMeta extends SubagentDispatchMeta {
  readonly runInBackground: boolean;
  readonly parentAgentId: string;
  readonly subagentType: string;
  readonly title: string;
  readonly startedAtMs: number;
  readonly quietOrigin?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSubagentRuntime(host: SubagentRuntimeHost) {
  const now = host.now ?? Date.now;
  const subagentSessions = new Map<string, SubagentSession>();
  const backgroundSubagentRuns = new Map<string, Promise<SubagentRunOutcome>>();
  const subagentMeta = new Map<string, RuntimeMeta>();
  const subagentRegistry = new Map<string, SubagentRecord>();
  const subagentOutlines = new Map<string, readonly unknown[]>();
  const pendingSubagentSteers = new Map<string, string>();
  const abortingSubagents = new Set<string>();

  let onBackgroundSubagentDispatched:
    | ((event: {
      parentAgentId: string;
      subagentAgentId: string;
      subagentType: string;
      toolCallId: string;
      subagentRequestId: string;
    }) => void)
    | undefined;
  let onBackgroundSubagentSettled:
    | ((completion: BackgroundSubagentCompletion) => void)
    | undefined;
  let onSubagentsChanged:
    | ((event: { parentAgentId: string; subagents: readonly ReturnType<typeof listSubagents>[number][] }) => void)
    | undefined;

  function emitSubagentsChanged(): void {
    onSubagentsChanged?.({
      parentAgentId: host.getConversationId(),
      subagents: listSubagents(),
    });
  }

  function logLifecycle(
    phase: "dispatched" | "settled",
    subagentAgentId: string,
    status?: SubagentRecord["status"],
  ): void {
    const record = subagentRegistry.get(subagentAgentId);
    const label = record == null ? "" : ` [${record.subagentType}] "${record.title}"`;
    host.log?.(`[sand][subagent] ${phase} ${subagentAgentId}${label}${status == null ? "" : ` status=${status}`}`);
  }

  function dispatchBackgroundSubagent(params: DispatchParams): void {
    void dispatchSubagent(params, true);
  }

  function dispatchForegroundSubagent(params: DispatchParams): Promise<SubagentRunOutcome> {
    return dispatchSubagent(params, false);
  }

  function dispatchSubagent(params: DispatchParams, runInBackground: boolean): Promise<SubagentRunOutcome> {
    const existing = backgroundSubagentRuns.get(params.subagentAgentId);
    if (existing != null) return existing;

    const title = deriveBackgroundSubagentTitle(params.prompt);
    const startedAtMs = now();
    const parentAgentId = host.getConversationId();
    const meta: RuntimeMeta = {
      runInBackground,
      parentAgentId,
      subagentType: params.subagentType,
      toolCallId: params.toolCallId,
      title,
      startedAtMs,
      ...(params.lineage == null ? {} : { lineage: params.lineage }),
      ...(params.quietOrigin == null ? {} : { quietOrigin: params.quietOrigin }),
    };
    subagentMeta.set(params.subagentAgentId, meta);
    subagentRegistry.set(params.subagentAgentId, {
      subagentType: params.subagentType,
      title,
      startedAtMs,
      status: "running",
    });

    logLifecycle("dispatched", params.subagentAgentId);
    if (runInBackground) onBackgroundSubagentDispatched?.({
      parentAgentId,
      subagentAgentId: params.subagentAgentId,
      subagentType: params.subagentType,
      toolCallId: params.toolCallId,
      subagentRequestId: computeSubagentRequestId(params.toolCallId),
    });
    if (runInBackground) host.onPendingWakeArmed?.({
      parentAgentId,
      kind: "subagent",
      workId: params.subagentAgentId,
      title,
      subagentType: params.subagentType,
      ...(params.quietOrigin == null ? {} : { quietOrigin: params.quietOrigin }),
    });
    emitSubagentsChanged();
    host.emitAsyncTasksChanged();
    return startBackgroundSubagentTurn(params.subagentAgentId, params.run);
  }

  function startBackgroundSubagentTurn(
    subagentAgentId: string,
    runTurn: () => Promise<SubagentRunResult>,
  ): Promise<SubagentRunOutcome> {
    let turn: Promise<SubagentRunResult>;
    try {
      turn = runTurn();
    } catch (error) {
      turn = Promise.reject(error);
    }

    const promise = turn
      .then((result) =>
        settleBackgroundSubagentTurn(
          subagentAgentId,
          result.aborted
            ? { status: "aborted" }
            : { status: "completed", text: result.text },
        ),
        (error: unknown) =>
        settleBackgroundSubagentTurn(subagentAgentId, {
          status: "error",
          error: errorMessage(error),
        }),
      );
    backgroundSubagentRuns.set(subagentAgentId, promise);
    return promise;
  }

  async function settleBackgroundSubagentTurn(
    subagentAgentId: string,
    outcome: SubagentRunOutcome,
  ): Promise<SubagentRunOutcome> {
    const runner = subagentSessions.get(subagentAgentId);
    const meta = subagentMeta.get(subagentAgentId);

    if (runner != null) {
      try {
        subagentOutlines.set(
          subagentAgentId,
          await runner.getResolvedOutline(),
        );
      } catch {}
    }

    const pendingSteer = pendingSubagentSteers.get(subagentAgentId);
    if (
      pendingSteer != null
      && runner != null
      && !abortingSubagents.has(subagentAgentId)
    ) {
      pendingSubagentSteers.delete(subagentAgentId);
      return startBackgroundSubagentTurn(subagentAgentId, () => {
        const prompt = formatSteerPrompt(pendingSteer);
        return meta == null
          ? runner.run(prompt)
          : runner.run(prompt, subagentSteerRunOptions(meta));
      });
    }

    pendingSubagentSteers.delete(subagentAgentId);
    const aborted = abortingSubagents.delete(subagentAgentId);
    const record = subagentRegistry.get(subagentAgentId);
    if (record != null) {
      record.status = aborted || outcome.status === "aborted"
        ? "aborted"
        : outcome.status === "completed"
          ? "done"
          : "error";
      logLifecycle("settled", subagentAgentId, record.status);
      emitSubagentsChanged();
    }
    host.emitAsyncTasksChanged();

    host.computerUse.freeWindow(subagentAgentId);
    subagentSessions.delete(subagentAgentId);
    subagentMeta.delete(subagentAgentId);
    backgroundSubagentRuns.delete(subagentAgentId);

    const isComputerUse = meta != null
      && host.isComputerUseSubagentType?.(meta.subagentType) === true;
    if (isComputerUse && meta != null) {
      const usage = runner?.getComputerUseUsageSnapshot?.();
      host.onComputerUseUsage?.({
        parentAgentId: meta.parentAgentId,
        subagentAgentId,
        subagentType: meta.subagentType,
        subagentRequestId: computeSubagentRequestId(meta.toolCallId),
        ...(usage?.modelId == null ? {} : { modelId: usage.modelId }),
        outcome: aborted || outcome.status === "aborted"
          ? "aborted"
          : outcome.status,
        durationMs: Math.max(0, now() - meta.startedAtMs),
        toolCallCount: runner?.getObservedToolCallCount() ?? 0,
        turnEndedCount: usage?.turnEndedCount ?? 0,
        ...(usage?.usage == null ? {} : { usage: usage.usage }),
      });

      if (host.actionAuditor != null && runner != null) {
        const actionCounts: Record<string, number> = {};
        let actionCount = 0;
        for (const [kind, count] of runner.getComputerUseAuditActionCounts?.() ?? []) {
          actionCounts[kind] = count;
          actionCount += count;
        }
        host.actionAuditor.record({
          agentId: host.getConversationId(),
          ...(meta.toolCallId.length === 0
            ? {}
            : { turnId: computeSubagentRequestId(meta.toolCallId) }),
          boxId: host.resolveBoxId(),
          occurredAtMs: now(),
          action: {
            kind: "computerUseSession",
            toolCallId: meta.toolCallId,
            actionCount,
            actionCounts,
            durationMs: Math.max(0, now() - meta.startedAtMs),
            screenshotCount: actionCounts.screenshot ?? 0,
          },
        });
      }
    }

    if (aborted) {
      if (meta?.runInBackground === true) {
        host.onPendingWakeDisarmed?.({
          parentAgentId: meta.parentAgentId,
          kind: "subagent",
          workId: subagentAgentId,
        });
      }
      return { status: "aborted" };
    }
    if (meta?.runInBackground !== true || onBackgroundSubagentSettled == null) return outcome;

    onBackgroundSubagentSettled({
      parentAgentId: meta.parentAgentId,
      subagentAgentId,
      subagentType: meta.subagentType,
      toolCallId: meta.toolCallId,
      title: meta.title,
      status: outcome.status === "completed" ? "completed" : "error",
      result: outcome.status === "completed"
        ? outcome.text.trim().length > 0
          ? outcome.text.trim()
          : "(the task finished without producing any text output)"
        : outcome.status === "aborted"
          ? "The background task was interrupted before it finished."
          : outcome.error,
      ...(meta.quietOrigin == null ? {} : { quietOrigin: meta.quietOrigin }),
    });
    return outcome;
  }

  function buildRunningSubagentInfo(
    subagentAgentId: string,
  ): RunningSubagentInfo | null {
    if (!backgroundSubagentRuns.has(subagentAgentId)) return null;
    const meta = subagentMeta.get(subagentAgentId);
    if (meta == null) return null;
    const runner = subagentSessions.get(subagentAgentId);
    return {
      subagentId: subagentAgentId,
      subagentType: meta.subagentType,
      title: meta.title,
      elapsedMs: Math.max(0, now() - meta.startedAtMs),
      toolCallCount: runner?.getObservedToolCallCount() ?? 0,
      recentActivity: runner?.getActivitySnapshot() ?? [],
      transcriptPath: runner?.getTranscriptPath() ?? null,
    };
  }

  function listRunningSubagents(): RunningSubagentInfo[] {
    const infos: RunningSubagentInfo[] = [];
    for (const id of backgroundSubagentRuns.keys()) {
      const info = buildRunningSubagentInfo(id);
      if (info != null) infos.push(info);
    }
    return infos;
  }

  function getRunningSubagent(id: string): RunningSubagentInfo | null {
    return buildRunningSubagentInfo(id);
  }

  function steerSubagent(
    subagentAgentId: string,
    message: string,
  ): "ok" | "not-running" {
    const runner = subagentSessions.get(subagentAgentId);
    if (
      runner == null
      || !backgroundSubagentRuns.has(subagentAgentId)
      || abortingSubagents.has(subagentAgentId)
    ) return "not-running";

    pendingSubagentSteers.set(subagentAgentId, message);
    runner.interrupt("Steering message from the parent agent.");
    return "ok";
  }

  function abortSubagent(
    subagentAgentId: string,
  ): "ok" | "not-running" {
    const runner = subagentSessions.get(subagentAgentId);
    if (runner == null || !backgroundSubagentRuns.has(subagentAgentId)) {
      return "not-running";
    }

    abortingSubagents.add(subagentAgentId);
    pendingSubagentSteers.delete(subagentAgentId);
    const meta = subagentMeta.get(subagentAgentId);
    if (meta?.runInBackground === true) {
      host.onPendingWakeDisarmed?.({
        parentAgentId: meta.parentAgentId,
        kind: "subagent",
        workId: subagentAgentId,
      });
    }
    host.emitAsyncTasksChanged();
    runner.interrupt("Stopped by the parent agent.");
    return "ok";
  }

  function listSubagents() {
    return [...subagentRegistry.entries()]
      .map(([subagentId, record]) => ({
        subagentId,
        subagentType: record.subagentType,
        title: record.title,
        status: record.status,
        startedAtMs: record.startedAtMs,
      }))
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }

  async function getSubagentOutline(id: string): Promise<readonly unknown[]> {
    const live = subagentSessions.get(id);
    if (live != null) return live.getResolvedOutline();
    return subagentOutlines.get(id) ?? [];
  }

  return {
    sessions: subagentSessions,
    registryEntries: () => subagentRegistry.entries(),
    notifyBackgroundWorkSettled(completion: BackgroundSubagentCompletion): void {
      onBackgroundSubagentSettled?.(completion);
    },
    reset(): void {
      subagentSessions.clear();
      subagentRegistry.clear();
      subagentOutlines.clear();
      emitSubagentsChanged();
    },
    isAborting: (id: string): boolean => abortingSubagents.has(id),
    isRunning: (id: string): boolean => backgroundSubagentRuns.has(id),
    dispatchBackgroundSubagent,
    dispatchForegroundSubagent,
    startBackgroundSubagentTurn,
    listRunningSubagents,
    getRunningSubagent,
    steerSubagent,
    abortSubagent,
    listSubagents,
    hasSubagent: (id: string): boolean => subagentRegistry.has(id),
    hasRunningSubagents(): boolean {
      return [...subagentRegistry.values()].some(
        (record) => record.status === "running",
      );
    },
    getSubagentOutline,
    async drainBackgroundSubagents(): Promise<void> {
      await Promise.allSettled([...backgroundSubagentRuns.values()]);
    },
    setBackgroundSubagentHandler(
      handler: (completion: BackgroundSubagentCompletion) => void,
    ): void {
      onBackgroundSubagentSettled = handler;
    },
    setBackgroundSubagentDispatchHandler(
      handler: NonNullable<typeof onBackgroundSubagentDispatched>,
    ): void {
      onBackgroundSubagentDispatched = handler;
    },
    setSubagentEventHandler(
      handler: NonNullable<typeof onSubagentsChanged>,
    ): void {
      onSubagentsChanged = handler;
    },
  };
}
