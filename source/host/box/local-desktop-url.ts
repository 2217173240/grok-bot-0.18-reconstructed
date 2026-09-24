import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AWAITING_HUMAN_URL_FILE } from "./awaiting-human.js";

export async function readLocalDesktopUrl(desktopEnabled: boolean, workspaceRoot: string): Promise<string> {
  if (!desktopEnabled) return "";
  let text: string;
  try {
    text = await readFile(join(workspaceRoot, ".grokbot", AWAITING_HUMAN_URL_FILE), "utf8");
  } catch {
    throw new Error("Local desktop connection file is unavailable: .grokbot/novnc-url");
  }
  const value = text.trim();
  const url = URL.parse(value);
  if (/[\u0000-\u0020\u007f]/.test(value) || url == null || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.port !== "6080" || url.pathname !== "/vnc.html" || url.username !== "" || url.password !== "" || url.hash !== ""
    || url.searchParams.getAll("path").length !== 1 || !/^websockify\?token=[a-f0-9]{64}$/.test(url.searchParams.get("path") ?? "")
    || url.searchParams.getAll("autoconnect").length !== 1 || url.searchParams.get("autoconnect") !== "1"
    || [...url.searchParams.keys()].some(key => key !== "path" && key !== "autoconnect")) {
    throw new Error("Local desktop connection file is invalid: expected an authenticated loopback noVNC URL on port 6080");
  }
  return value;
}
