export { localDockerPlatform } from "./local-runtime-profile.mjs";
export type { LocalDockerPlatform } from "./local-runtime-profile.mjs";

// Docker --mount 使用 CSV 字段；Windows 盘符、空格和反斜线直接保留。
export function dockerBindMount(source: string, destination: string, readonly = false): string {
  const field = (value: string): string => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return ["type=bind", field(`src=${source}`), field(`dst=${destination}`), ...(readonly ? ["readonly"] : [])].join(",");
}
