import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type SdkTransport = Pick<Transport, "start" | "send" | "close"> & {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  sessionId?: string | undefined;
  setProtocolVersion?: Transport["setProtocolVersion"];
};

// SDK 类允许显式 undefined；项目的 exactOptionalPropertyTypes 要求可选属性保持缺省。
export function adaptSdkTransport(transport: SdkTransport, options: { waitForClose?: boolean } = {}): Transport {
  let closing: Promise<void> | undefined;
  let started = false;
  let starting: Promise<void> | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const adapter: Transport = {
    start: () => starting ??= transport.start().then(() => { started = true; }),
    send: (message, options) => transport.send(message, options),
    close: () => closing ??= (async () => {
      if (options.waitForClose) await starting?.catch(() => undefined);
      await transport.close();
      // stdio SDK 发出 SIGKILL 后可能先返回；资源关闭以子进程 close 事件为准。
      if (options.waitForClose && started) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("MCP stdio transport did not close after shutdown")), 5000);
          })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }
    })(),
  };
  transport.onclose = () => { markClosed(); adapter.onclose?.(); };
  transport.onerror = error => adapter.onerror?.(error);
  transport.onmessage = (message, extra) => adapter.onmessage?.(message, extra);
  Object.defineProperty(adapter, "sessionId", { get: () => transport.sessionId });
  if (transport.setProtocolVersion != null) adapter.setProtocolVersion = version => transport.setProtocolVersion?.(version);
  return adapter;
}
