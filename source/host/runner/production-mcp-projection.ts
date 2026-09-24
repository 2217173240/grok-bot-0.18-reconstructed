import { McpArgs } from "../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import type { TurnMcpForTurn } from "./turn-agent-composition.js";
import type { TurnMcpMetaToolFactoryInput } from "./tools/turn-toolset.js";
import type { AutoReviewModes } from "./auto-review-gate.js";
import { RequestContext, RequestContextEnv } from "../../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import { createSandMcpApprovalProvider } from "./sand-auto-review-tool-escalations.js";
import { sandAutoReviewApprovalExpiryPolicy, type SandAutoReviewController } from "./sand-auto-review.js";

export function createProductionMcpToolInputs(input: {
  readonly resourceAccessor: TurnMcpMetaToolFactoryInput["resourceAccessor"];
  readonly getMcpTools: TurnMcpMetaToolFactoryInput["getMcpTools"];
  readonly mode: AutoReviewModes["mcp"];
  readonly agentId: string;
  readonly controller?: SandAutoReviewController;
  readonly userInstructions?: { readonly allowInstructions: readonly string[]; readonly blockInstructions: readonly string[] };
}): TurnMcpMetaToolFactoryInput {
  return {
    resourceAccessor: input.resourceAccessor,
    getMcpTools: input.getMcpTools,
    discoveryOptions: { allowInteractiveMcpAuth: false },
    callOptions: {
      allowInteractiveMcpAuth: false,
      requestContext: new RequestContext({ env: new RequestContextEnv({ smartModeClassifierAutoModeEnabled: true }) }),
      smartModeClassifierMode: input.mode === "enforce",
      smartModeClassifierShadowMode: input.mode === "shadow",
      ...(input.userInstructions === undefined ? {} : { userAutoRunInstructions: input.userInstructions }),
      ...(input.controller === undefined ? {} : {
        smartModeApprovalProvider: {
          requestApproval: request => createSandMcpApprovalProvider({
            controller: input.controller!,
            agentId: input.agentId,
            getExpiryPolicy: () => sandAutoReviewApprovalExpiryPolicy("turn"),
          }).requestApproval({
            fingerprint: request.fingerprint,
            signal: request.signal,
            target: {
              blockReason: request.target.blockReason,
              serverDisplayName: request.target.serverDisplayName ?? request.target.serverName ?? request.target.serverIdentifier,
              toolName: request.target.toolName,
              ...(request.target.mcpArguments === undefined ? {} : { mcpArguments: request.target.mcpArguments }),
              ...(request.target.description === undefined ? {} : { description: request.target.description }),
              ...(request.target.proposedAllowRule === undefined ? {} : { proposedAllowRule: request.target.proposedAllowRule }),
            },
          }),
        },
      }),
    },
  };
}

export function createProductionMcpForTurn(mcp: TurnMcpForTurn): TurnMcpForTurn {
  return {
    createExecutor: (persistImage, spillLargeText, auditIdentity) => {
      const executor = mcp.createExecutor(persistImage, spillLargeText, auditIdentity);
      return {
        execute: (context, args, options) => executor.execute(context, new McpArgs({
          ...args,
          name: args.toolName,
        }), options),
      };
    },
    createStateExecutor: () => mcp.createStateExecutor(),
    ...(mcp.resolveNeedsAuthSlot === undefined ? {} : {
      resolveNeedsAuthSlot: (identifier: string) => mcp.resolveNeedsAuthSlot!(identifier),
    }),
  };
}
