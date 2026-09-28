import type { Context } from "../../../packages/context/core.js";

export interface TextOnlyInferenceOwner {
  completeTextOnly(context: Context, instructions: string, input: string): Promise<string>;
}

export interface TextOnlyCompletionStream {
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string; readonly error?: unknown }>;
  readonly response: Promise<{ readonly messages: readonly { readonly role: string; readonly content: unknown }[] }>;
}

export async function consumeTextOnlyCompletion(context: Context, stream: TextOnlyCompletionStream): Promise<string> {
  let text = "";
  context.signal.throwIfAborted();
  for await (const chunk of stream.fullStream) {
    context.signal.throwIfAborted();
    if (chunk.type.startsWith("tool-")) throw new Error("Text-only inference returned a tool call.");
    if (chunk.type === "error") throw new Error("Text-only inference failed.", { cause: chunk.error });
    if (chunk.type === "text-delta") {
      if (typeof chunk.textDelta !== "string") throw new Error("Text-only inference returned an invalid text chunk.");
      text += chunk.textDelta;
      if (Buffer.byteLength(text, "utf8") > 16_384) throw new Error("Text-only inference response is too large.");
    }
  }
  const response = await stream.response;
  context.signal.throwIfAborted();
  for (const message of response.messages) {
    if (message.role === "tool" || Array.isArray(message.content) && message.content.some(part => typeof part?.type === "string" && part.type.startsWith("tool-"))) {
      throw new Error("Text-only inference returned tool execution content.");
    }
  }
  if (text.trim().length === 0) throw new Error("Text-only inference returned no text.");
  return text;
}
