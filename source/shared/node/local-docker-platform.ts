export interface LocalDockerPlatform {
  readonly image: string;
  readonly dockerPlatform: "linux/arm64" | "linux/amd64";
  readonly dataVolume: string;
}

export function localDockerPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): LocalDockerPlatform {
  if (platform === "win32" && arch !== "x64") throw new Error(`Windows Docker execution requires x64; unsupported architecture: ${arch}`);
  const arm64 = platform !== "win32" && arch === "arm64";
  const suffix = arm64 ? "arm64" : "amd64";
  return { image: `grok-bot-exec-box:${suffix}`, dockerPlatform: `linux/${suffix}`, dataVolume: `grok-bot-local-vm-data-${suffix}` };
}

// Docker --mount 使用 CSV 字段；Windows 盘符、空格和反斜线直接保留。
export function dockerBindMount(source: string, destination: string, readonly = false): string {
  const field = (value: string): string => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return ["type=bind", field(`src=${source}`), field(`dst=${destination}`), ...(readonly ? ["readonly"] : [])].join(",");
}
