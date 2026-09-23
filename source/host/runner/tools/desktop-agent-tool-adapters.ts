import { Buffer } from "node:buffer";
import { z } from "zod";
import type { Context } from "../../../packages/context/core.js";
import { ToolCall } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  ComputerUseError,
  ComputerUseResult as GeneratedComputerUseResult,
  ComputerUseSuccess,
  ComputerUseToolCall,
} from "../../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import { createImageResult, createStringResult } from "../../../packages/chat-inference/prompt-executor.js";
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/common.js";
import { detectImageMimeType } from "../../../packages/agent/tools/core/read/image-utils.js";
import { toGeneratedComputerUseArgs } from "../host-computer-tool-dependencies.js";
import {
  createComputerTool,
  createScreenshotTool,
  describeOutcome,
  toAction,
  type ComputerActionArgs,
  type ComputerToolDependencies,
  type ComputerUseResult,
  type ComputerUseSuccess as PlainComputerUseSuccess,
} from "./sand-computer-tool.js";
import { createSandBrowserTools, type BrowserDriverDependencies, type BrowserDriverOutput } from "./sand-browser-tools.js";
import {
  buildErrorResult,
  buildSuccessResult,
  completedToolCall,
  emptyToolCall,
  toolCallWrapper,
} from "./communicate-tool.js";

const browserFields = {
  viewId: z.string(), url: z.string(), ref: z.string(), element: z.string(),
  text: z.string(), value: z.string(), values: z.array(z.string()), key: z.string(),
  x: z.number(), y: z.number(), sourceRef: z.string(), targetRef: z.string(),
  targetX: z.number(), targetY: z.number(), newTab: z.boolean(), submit: z.boolean(),
  clear: z.boolean(), doubleClick: z.boolean(), button: z.string(),
  modifiers: z.array(z.string()), direction: z.enum(["up", "down", "left", "right"]),
  amount: z.number(), fullPage: z.boolean(), durationMs: z.number(),
  method: z.string(), params: z.record(z.unknown()),
  action: z.enum(["list", "new", "close", "select"]), index: z.number().int(),
} as const;

const browserFieldsByOp: Readonly<Record<string, readonly (keyof typeof browserFields)[]>> = {
  navigate: ["url", "newTab", "viewId"], snapshot: ["viewId"],
  click: ["ref", "element", "button", "doubleClick", "modifiers", "viewId"],
  mouse_click_xy: ["x", "y", "button", "doubleClick", "modifiers", "viewId"],
  type: ["ref", "element", "text", "submit", "clear", "viewId"],
  fill: ["ref", "element", "value", "viewId"],
  select_option: ["ref", "element", "values", "viewId"],
  press_key: ["key", "viewId"],
  scroll: ["ref", "element", "direction", "amount", "x", "y", "viewId"],
  drag: ["sourceRef", "targetRef", "targetX", "targetY", "viewId"],
  get_bounding_box: ["ref", "element", "viewId"],
  highlight: ["ref", "element", "durationMs", "viewId"],
  cdp: ["method", "params", "viewId"],
  tabs: ["action", "index", "viewId"],
  screenshot: ["fullPage", "viewId"],
};

function browserParameters(op: string, required: readonly string[]) {
  const fields = browserFieldsByOp[op];
  if (fields === undefined) throw new TypeError(`Unknown Browser operation: ${op}`);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field] = required.includes(field) ? browserFields[field] : browserFields[field].optional();
  }
  for (const field of required) {
    if (shape[field] === undefined) throw new TypeError(`Browser operation ${op} has an unknown required field: ${field}`);
  }
  return z.object(shape).passthrough();
}

interface ToolInteractionHandler {
  executeToolCall<Result>(
    context: Context,
    initial: ToolCall,
    toolCallId: string,
    execute: (context: Context) => Promise<Result>,
    complete: (result: Result) => ToolCall,
  ): Promise<Result>;
}

function computerCall(args?: ComputerUseToolCall["args"], result?: GeneratedComputerUseResult): ToolCall {
  return new ToolCall({ tool: { case: "computerUseToolCall", value: new ComputerUseToolCall({
    ...(args === undefined ? {} : { args }),
    ...(result === undefined ? {} : { result }),
  }) } });
}

function generatedResult(result: ComputerUseResult): GeneratedComputerUseResult {
  if (result.result.case === "success") {
    const value = result.result.value as PlainComputerUseSuccess;
    return new GeneratedComputerUseResult({ result: { case: "success", value: new ComputerUseSuccess({
      ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }),
      ...(value.screenshotPath === undefined ? {} : { screenshotPath: value.screenshotPath }),
      ...(value.cursorPosition === undefined ? {} : { cursorPosition: value.cursorPosition }),
    }) } });
  }
  const error = result.result.case === "error" ? (result.result.value as { error: string }).error : "Computer returned no result.";
  return new GeneratedComputerUseResult({ result: { case: "error", value: new ComputerUseError({ error }) } });
}

function renderComputer(result: GeneratedComputerUseResult, operation: "computer" | "screenshot") {
  const plain = result as ComputerUseResult;
  const description = describeOutcome(plain, operation);
  if (result.result.case === "success" && result.result.value.screenshot) {
    const screenshot = result.result.value.screenshot;
    const mime = detectImageMimeType(Buffer.from(screenshot, "base64"));
    if (mime === undefined) throw new TypeError("Computer returned an unknown screenshot format");
    return createImageResult(screenshot, mime, description);
  }
  return createStringResult(description, result.result.case !== "success");
}

export function createAgentComputerTool(deps: ComputerToolDependencies<Context>, operation: "computer" | "screenshot") {
  const computer = createComputerTool(deps);
  const screenshot = createScreenshotTool(deps);
  const legacy = operation === "computer" ? computer : screenshot;
  return createZodAgentTool("OPENAI_COMPUTER_USE", {
    name: legacy.name,
    descriptionGenerator: () => operation === "computer"
      ? "Use the box desktop mouse and keyboard. Each action also captures a screenshot."
      : "Capture the current box desktop screenshot.",
    parameters: legacy.parameters,
    execute: withSafeParsedArgs(legacy.parameters, async (
      context: Context,
      interactionHandler: ToolInteractionHandler,
      input: ComputerActionArgs,
      meta: { readonly toolCallId: string; readonly stateHandler?: unknown; readonly workspacePaths?: readonly string[] },
    ) => {
      const sequence = operation === "computer" ? [input, ...(input.then ?? [])] : [{ action: "screenshot" } as ComputerActionArgs];
      const actions = sequence.map(toAction);
      if (sequence.at(-1)?.action !== "screenshot") actions.push(toAction({ action: "screenshot" }));
      const args = toGeneratedComputerUseArgs({ toolCallId: meta.toolCallId, actions });
      return interactionHandler.executeToolCall(
        context,
        computerCall(args),
        meta.toolCallId,
        async () => generatedResult(await (operation === "computer" ? computer.execute(input, {
          context,
          toolCallId: meta.toolCallId,
          signal: context.signal,
          stateHandler: meta.stateHandler,
          ...(meta.workspacePaths === undefined ? {} : { workspacePaths: meta.workspacePaths }),
        }) : screenshot.execute({}, { context, toolCallId: meta.toolCallId }))),
        result => computerCall(args, result),
      );
    }, computerCall()),
    render: async (_context: Context, result: GeneratedComputerUseResult) => renderComputer(result, operation),
    serializeError: (error: unknown) => computerCall(undefined, new GeneratedComputerUseResult({
      result: { case: "error", value: new ComputerUseError({ error: error instanceof Error ? error.message : String(error) }) },
    })),
  });
}

export function createAgentBrowserTools(deps: BrowserDriverDependencies<Context>) {
  return createSandBrowserTools(deps).map(legacy => {
    const parameters = browserParameters(legacy.op, legacy.schema.required ?? []);
    return createZodAgentTool(legacy.id, {
      name: legacy.name,
      descriptionGenerator: () => legacy.description,
      parameters,
      execute: withSafeParsedArgs(parameters, async (
        context: Context,
        interactionHandler: ToolInteractionHandler,
        input: Record<string, unknown>,
        meta: { readonly toolCallId: string; readonly stateHandler?: unknown; readonly workspacePaths?: readonly string[] },
      ) => interactionHandler.executeToolCall(
        context,
        toolCallWrapper({ phase: "executing", tool: legacy.name }),
        meta.toolCallId,
        async () => legacy.execute(context, input, meta),
        result => completedToolCall(result.isError === true ? buildErrorResult(result.text) : buildSuccessResult(result.text)),
      ), emptyToolCall()),
      render: async (_context: Context, result: BrowserDriverOutput) => {
        const rendered = legacy.render(result);
        if (rendered.kind === "image" && rendered.imageB64) {
          const mime = detectImageMimeType(Buffer.from(rendered.imageB64, "base64"));
          if (mime === undefined) throw new TypeError("Browser returned an unknown screenshot format");
          return createImageResult(rendered.imageB64, mime, rendered.text, rendered.isError === true);
        }
        return createStringResult(rendered.text, rendered.isError === true);
      },
      serializeError: (error: unknown) => completedToolCall(buildErrorResult(error instanceof Error ? error.message : String(error))),
    });
  });
}
