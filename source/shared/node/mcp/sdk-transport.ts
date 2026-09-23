import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type SdkTransport = Pick<Transport, "start" | "send" | "close"> & {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  sessionId?: string | undefined;
  setProtocolVersion?: Transport["setProtocolVersion"];
};

// SDK 类允许显式 undefined；项目的 exactOptionalPropertyTypes 要求可选属性保持缺省。
export function adaptSdkTransport(transport: SdkTransport): Transport {
  let closing: Promise<void> | undefined;
  const adapter: Transport = {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => closing ??= Promise.resolve().then(() => transport.close()),
  };
  transport.onclose = () => adapter.onclose?.();
  transport.onerror = error => adapter.onerror?.(error);
  transport.onmessage = (message, extra) => adapter.onmessage?.(message, extra);
  Object.defineProperty(adapter, "sessionId", { get: () => transport.sessionId });
  if (transport.setProtocolVersion != null) adapter.setProtocolVersion = version => transport.setProtocolVersion?.(version);
  return adapter;
}
