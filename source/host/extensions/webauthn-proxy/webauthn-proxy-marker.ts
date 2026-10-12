import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../../../shared/node/atomic-write.js";

export const SAND_WEBAUTHN_PROXY_MARKER_PATH = "/home/box/.sand-webauthn-proxy-enabled";
export const BOX_CHROME_POLICY_COMMAND = "/usr/local/bin/box-chrome-policy";

export function applyWebAuthnProxyMarker(
  enabled: boolean,
  markerPath = SAND_WEBAUTHN_PROXY_MARKER_PATH,
  policyCommand = BOX_CHROME_POLICY_COMMAND
): "not-a-box" | "unchanged" | "applied" {
  if (!existsSync(dirname(markerPath))) return "not-a-box";
  const entry = lstatSync(markerPath, { throwIfNoEntry: false });
  if (enabled ? entry != null && !entry.isSymbolicLink() : entry == null) return "unchanged";
  if (enabled) writeFileAtomicSync(markerPath, "", { mode: 0o644 });
  else unlinkSync(markerPath);
  if (existsSync(policyCommand)) spawnSync(policyCommand, [], { stdio: "ignore" });
  return "applied";
}

