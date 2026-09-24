import { join } from "node:path";

import { errorLogTag } from "../../shared/errors.js";
import { reportHostDiagnostic } from "../host-diagnostics.js";
import type { HostBoxInner } from "../extensions/forever-box/host-box.js";
import {
  applyBoxEnvironmentViaTransport,
  type BoxEnvironmentControlClient,
  type BoxEnvironmentUpdate
} from "./box-env.js";
import { uploadFileViaExecDaemon, type FileTransferAccessor } from "./box-file-transfer.js";
import { applySharedDesktop, createSandBox } from "./box-factory.js";
import {
  loadBoxMcpServersViaTransport,
  type BoxMcpControlClient
} from "./box-mcp.js";
import {
  createBoxRemoteResourceAccessorFromTransport,
  createBoxTransport,
  pingBoxTransportClassified,
  type BoxControlClientFactory,
  type BoxPingControlClient,
  type BoxRemoteExecClient,
  type BoxRemoteExecManager,
  type BoxTransportFactory
} from "./box-remote-accessor.js";
import type {
  BoxEndpoint,
  LoopbackTelemetry,
  PingResult
} from "./loopback-sand-box.js";
import { resolveExecDaemonAuthTokenFromEnv } from "./loopback-sand-box.js";
import { localDesktopComputerUseEnabled } from "./local-computer-use.js";
import { readLocalDesktopUrl } from "./local-desktop-url.js";
import { createAwaitingHumanState, type AwaitingHumanState } from "./awaiting-human.js";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.js";
import { shellExecutorResource } from "../../packages/agent-exec/shell.js";
import { shellStreamExecutorResource } from "../../packages/agent-exec/shell-stream.js";
import { CombinedResourceAccessor, resourceEntry } from "../../packages/agent-exec/resource-provider.js";
import { getSandRootDir } from "../host-paths.js";
import type { Context } from "../../packages/context/core.js";
import type { Executor, ExecutorOptions, StreamExecutor } from "../../packages/agent-exec/remote.js";
import type { ShellArgs, ShellResult, ShellStream } from "../../packages/proto/generated/agent/v1/shell_exec_pb.js";
import type { ComputerUseArgs, ComputerUseResult } from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import type { ShellAccessor } from "./box-windows.js";

export type ProductionBoxControlClient = BoxPingControlClient &
  BoxEnvironmentControlClient &
  BoxMcpControlClient;

/**
 * The erased generated/runtime constructors at the exact host-bundle boundary.
 * This deliberately exposes no lifecycle or whole-box implementation port.
 */
export interface ProductionBoxGeneratedPorts<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
> {
  readonly createTransport: BoxTransportFactory<Transport>;
  createControlClient(transport: Transport): ProductionBoxControlClient;
  createExecClient(transport: Transport): BoxRemoteExecClient;
  createResourceAccessor(manager: BoxRemoteExecManager): Accessor;
  withFileReadGuard(
    accessor: Accessor,
    assertFileReadAllowed: (path: string) => Promise<void>
  ): Accessor;
  withNoMonitorComputerUse(accessor: Accessor): Accessor;
  /** The real desktop plane executor (XTEST input + desktop screenshots). */
  withLocalDesktopComputerUse(accessor: Accessor): Accessor;
}

export type ErasedProductionBoxGeneratedPorts = ProductionBoxGeneratedPorts<
  unknown,
  ShellAccessor & FileTransferAccessor
>;

export interface ProductionBoxProviderOptions<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
> {
  readonly generated: ProductionBoxGeneratedPorts<Transport, Accessor>;
  readonly telemetry: LoopbackTelemetry;
  readonly protectedBoxPaths: readonly string[];
  readonly host?: string;
  readonly authToken?: string;
  /**
   * The shipped co-resident image owns fork desktops and the 1339 router. The
   * reconstructed standalone exec daemon intentionally does not advertise
   * those absent capabilities, so agents use its authenticated primary
   * accessor instead of attempting /usr/local/bin/start-window.
   */
  readonly sharedDesktop?: boolean;
}

export type ProductionBoxInner = HostBoxInner & {
  dispose(): Promise<void>;
};

function createStandaloneProductionBoxInner<
  Accessor extends ShellAccessor & FileTransferAccessor
>(
  loopback: ReturnType<typeof createSandBox<Accessor>>,
  withComputerUse: (accessor: Accessor) => Accessor,
  desktopEnabled: boolean
): ProductionBoxInner {
  // The awaiting-human gate is host-side and lazily created once: box-facing
  // executors refuse while a handoff is pending (the ask/hand-back files
  // live in the shared workspace, so the agent's Mac-side tools can still
  // resolve the handoff — no deadlock).
  let gate: AwaitingHumanState | undefined;
  const workspaceRoot = process.env.SAND_WORKSPACE_ROOT?.trim() || join(getSandRootDir(), "box-workspace");
  const awaitingHumanGate = (): AwaitingHumanState => {
    gate ??= createAwaitingHumanState({
      root: join(workspaceRoot, ".grokbot"),
    });
    return gate;
  };
  const withAwaitingHuman = (accessor: Accessor): Accessor => {
    const state = awaitingHumanGate();
    const base = accessor as unknown as {
      get(resource: typeof shellExecutorResource): Executor<ShellArgs, ShellResult>;
      get(resource: typeof shellStreamExecutorResource): StreamExecutor<ShellArgs, ShellStream>;
      get(resource: typeof computerUseExecutorResource): Executor<ComputerUseArgs, ComputerUseResult>;
    };
    const wrapped = new CombinedResourceAccessor(
      accessor as unknown as ConstructorParameters<typeof CombinedResourceAccessor>[0],
      [
        resourceEntry(shellExecutorResource, {
          async execute(ctx: Context, args: ShellArgs, options?: ExecutorOptions): Promise<ShellResult> {
            state.assertNotAwaiting("shell");
            return await base.get(shellExecutorResource).execute(ctx, args, options);
          },
        } satisfies Executor<ShellArgs, ShellResult>),
        resourceEntry(shellStreamExecutorResource, {
          async *execute(ctx: Context, args: ShellArgs, options?: ExecutorOptions): AsyncIterable<ShellStream> {
            state.assertNotAwaiting("shell stream");
            yield* base.get(shellStreamExecutorResource).execute(ctx, args, options);
          },
        } satisfies StreamExecutor<ShellArgs, ShellStream>),
        resourceEntry(computerUseExecutorResource, {
          async execute(ctx: Context, args: ComputerUseArgs, options?: ExecutorOptions): Promise<ComputerUseResult> {
            state.assertNotAwaiting("computer use");
            return await base.get(computerUseExecutorResource).execute(ctx, args, options);
          },
        } satisfies Executor<ComputerUseArgs, ComputerUseResult>),
      ],
    );
    return wrapped as unknown as Accessor;
  };
  return {
    ensureReady: async (ctx, agentId) => {
      const primary = await loopback.ensureReady(ctx, agentId);
      const vncUrl = await readLocalDesktopUrl(desktopEnabled, workspaceRoot);
      return {
        ...primary,
        remoteAccessor: withAwaitingHuman(withComputerUse(primary.remoteAccessor)),
        vncUrl,
      };
    },
    runState: () => loopback.runState(),
    listBoxes: () => loopback.listBoxes(),
    uploadFile: (ctx, agentId, boxPath, data) =>
      loopback.uploadFile(ctx, agentId, boxPath, data),
    downloadFile: (ctx, agentId, boxPath) =>
      loopback.downloadFile(ctx, agentId, boxPath),
    releaseWindow: async () => {},
    getAgentWindowIndex: () => 1,
    maxWindows: () => 1,
    getTerminalsFolder: () => loopback.getTerminalsFolder(),
    isAvailable: () => loopback.isAvailable(),
    describe: () => loopback.describe(),
    applyEnvironment: (ctx, update) =>
      loopback.applyEnvironment(ctx, decodeBoxEnvironmentUpdate(update)),
    loadMcpServers: (ctx, configJson) =>
      loopback.loadMcpServers(ctx, configJson),
    mcpResourceAccessor: ctx => loopback.mcpResourceAccessor(ctx),
    dispose: () => loopback.dispose(),
  };
}

function decodeBoxEnvironmentUpdate(value: unknown): BoxEnvironmentUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("box environment update must be an object");
  }
  const rawEnvironment = Reflect.get(value, "env");
  const replace = Reflect.get(value, "replace");
  if (
    typeof rawEnvironment !== "object" ||
    rawEnvironment === null ||
    Array.isArray(rawEnvironment) ||
    typeof replace !== "boolean"
  ) {
    throw new TypeError("box environment update has an invalid shape");
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(rawEnvironment)) {
    if (typeof entry !== "string") {
      throw new TypeError(`box environment value for ${name} must be a string`);
    }
    env[name] = entry;
  }
  return { env, replace };
}

/**
 * Rebuilds the artifact's production construction:
 * HostBox(applySharedDesktop(createSandBox(...), { persistAssignments: true })).
 *
 * Artifact anchors:
 * - src/app/dist/host/host-main.cjs:614442-615551 (box primitives/factory)
 * - src/app/dist/host/host-main.cjs:616596-616605 (production composition)
 */
export function createProductionBoxInner<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
>(
  options: ProductionBoxProviderOptions<Transport, Accessor>
): ProductionBoxInner {
  const { generated } = options;
  const createControlClient: BoxControlClientFactory<Transport> = transport =>
    generated.createControlClient(transport);
  const transportFor = (endpoint: BoxEndpoint): Transport =>
    createBoxTransport(endpoint, generated.createTransport);

  const loopback = createSandBox<Accessor>({
    ...(options.host === undefined ? {} : { host: options.host }),
    authToken: options.authToken ?? resolveExecDaemonAuthTokenFromEnv(),
    telemetry: options.telemetry,
    protectedBoxPaths: options.protectedBoxPaths,
    operations: {
      async ping(ctx, endpoint): Promise<PingResult> {
        const result = await pingBoxTransportClassified(
          ctx,
          transportFor(endpoint),
          createControlClient
        );
        return result.causeSummary === undefined
          ? { outcome: result.outcome }
          : { outcome: result.outcome, causeSummary: result.causeSummary };
      },
      createRemoteAccessor(endpoint): Accessor {
        const transport = transportFor(endpoint);
        return createBoxRemoteResourceAccessorFromTransport(transport, {
          createExecClient: generated.createExecClient,
          createResourceAccessor: generated.createResourceAccessor
        });
      },
      protectRemoteAccessor(accessor, assertFileReadAllowed): Accessor {
        return generated.withFileReadGuard(accessor, assertFileReadAllowed);
      },
      async applyEnvironment(ctx, endpoint, update): Promise<void> {
        await applyBoxEnvironmentViaTransport(
          ctx,
          transportFor(endpoint),
          update,
          generated.createControlClient
        );
      },
      async loadMcpServers(ctx, endpoint, configJson): Promise<string[]> {
        return await loadBoxMcpServersViaTransport(
          ctx,
          transportFor(endpoint),
          configJson,
          generated.createControlClient
        );
      },
      async uploadFile(ctx, accessor, path, data): Promise<void> {
        await uploadFileViaExecDaemon(ctx, accessor, path, data);
      }
    }
  });

  if (options.sharedDesktop === false) {
    // The desktop opt-in replaces the no-monitor stub with the real plane:
    // XTEST input plus desktop-level screenshots, executed by this host
    // process inside the box (DISPLAY is exported by box-init-exec).
    const desktopEnabled = localDesktopComputerUseEnabled();
    return createStandaloneProductionBoxInner(
      loopback,
      desktopEnabled
        ? (accessor => generated.withLocalDesktopComputerUse(accessor))
        : (accessor => generated.withNoMonitorComputerUse(accessor)),
      desktopEnabled
    );
  }

  const composed = applySharedDesktop(loopback, {
    persistAssignments: true,
    gateComputerUse(primary) {
      return {
        ...primary,
        remoteAccessor: generated.withNoMonitorComputerUse(
          primary.remoteAccessor
        )
      };
    },
    reportPersistFailure(error) {
      reportHostDiagnostic({
        kind: "window_assignment_persist_failed",
        errorClass: errorLogTag(error)
      });
    }
  });
  return composed;
}
