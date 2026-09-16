import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Executor } from "../../packages/agent-exec/remote.js";
import type { ComputerUseArgs, ComputerUseResult, MouseButton } from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import { ComputerUseError, ComputerUseResult as ComputerUseResultConstructor, ComputerUseSuccess } from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";

// The real Computer tool for the local desktop plane (S-3). Input is XTEST
// injection via docker/bin/xtest-input-local.py (the Archive helper's ctypes
// core plus move/down/up); screenshots are desktop-level `xwd | convert`
// captures — the eyes must see more than the page (dialogs, download bars,
// crash screens). The headless exec plane keeps the no-monitor stub: this
// executor only mounts when the desktop opt-in brought the plane up.

// Mirror of box-common.sh SCREEN_GEOM (1280x800x24) — the bash constant is
// the single authority for what Xvfb starts with; the desktop gate profile
// asserts the two agree at runtime.
export const LOCAL_DESKTOP_GEOMETRY = { width: 1280, height: 800 } as const;
const XTEST_HELPER = "/usr/local/bin/xtest-input-local.py";
const SCREENSHOT_DIRECTORY = "/workspace/.grokbot/screenshots";
const INPUT_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const WAIT_CAP_MS = 30_000;

export function localDesktopComputerUseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAND_LOCAL_ADMIN_DESKTOP === "1";
}

function display(): string {
  const configured = process.env.DISPLAY?.trim();
  return configured != null && configured.length > 0 ? configured : ":1";
}

function assertPoint(x: unknown, y: unknown): { x: number; y: number } {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new LocalComputerUseError(`coordinates must be integers, got (${x},${y})`);
  const point = { x: x as number, y: y as number };
  if (point.x < 0 || point.y < 0 || point.x > LOCAL_DESKTOP_GEOMETRY.width - 1 || point.y > LOCAL_DESKTOP_GEOMETRY.height - 1) {
    throw new LocalComputerUseError(`coordinates out of bounds: (${point.x},${point.y}), legal range 0..${LOCAL_DESKTOP_GEOMETRY.width - 1} x 0..${LOCAL_DESKTOP_GEOMETRY.height - 1}`);
  }
  return point;
}

export class LocalComputerUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalComputerUseError";
  }
}

function xtestButton(button: MouseButton | undefined): number {
  switch (button) {
    case 2: return 3;  // RIGHT → xtest button 3
    case 3: return 2;  // MIDDLE → xtest button 2
    case 4: return 8;  // BACK
    case 5: return 9;  // FORWARD
    default: return 1; // UNSPECIFIED/LEFT
  }
}

function runXtest(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [XTEST_HELPER, display()], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), INPUT_TIMEOUT_MS);
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => { clearTimeout(timer); reject(new LocalComputerUseError(`desktop input helper failed to start: ${error.message}`)); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const message = stderr.trim() || `desktop input helper exited with ${code}`;
      reject(new LocalComputerUseError(code === 2 ? message : `desktop input failed: ${message}`));
    });
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

function captureDesktopPng(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Both ends of the pipe live in the box; the only interpolation is the
    // display name from the environment.
    const child = spawn("bash", ["-c", `xwd -root -display ${JSON.stringify(display())} -silent | convert xwd:- png:-`], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SCREENSHOT_TIMEOUT_MS);
    child.stdout?.on("data", chunk => chunks.push(chunk));
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => { clearTimeout(timer); reject(new LocalComputerUseError(`desktop capture failed to start: ${error.message}`)); });
    child.once("close", code => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      if (code === 0 && buffer.length > 0) return resolve(buffer);
      reject(new LocalComputerUseError(`desktop capture failed (code=${code}): ${stderr.trim()}`));
    });
  });
}

async function persistScreenshot(png: Buffer): Promise<string> {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  const path = join(SCREENSHOT_DIRECTORY, `${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  await writeFile(path, png);
  return path;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Executes the batch sequentially; the first failure aborts honestly with the
 * actions that did land recorded in the log — no blind retries (a GUI action
 * replayed after a failure is a different action, not the same one).
 */
export const localComputerUseExecutor: Executor<ComputerUseArgs, ComputerUseResult> = {
  async execute(_context, args): Promise<ComputerUseResult> {
    const startedAt = Date.now();
    const log: string[] = [];
    let lastScreenshotBase64: string | undefined;
    let lastScreenshotPath: string | undefined;
    let completed = 0;
    try {
      for (const action of args.actions) {
        const arm = action.action;
        const armCase = arm?.case;
        if (armCase == null) throw new LocalComputerUseError("action is unset");
        switch (armCase) {
          case "mouseMove": {
            const point = assertPoint(arm.value.coordinate?.x, arm.value.coordinate?.y);
            await runXtest({ action: "move", x: point.x, y: point.y });
            log.push(`mouseMove(${point.x},${point.y})`);
            break;
          }
          case "click": {
            const point = assertPoint(arm.value.coordinate?.x, arm.value.coordinate?.y);
            const count = arm.value.count > 0 ? arm.value.count : 1;
            for (let index = 0; index < count; index += 1) await runXtest({ action: "click", x: point.x, y: point.y, button: xtestButton(arm.value.button) });
            log.push(`click(${point.x},${point.y})x${count}`);
            break;
          }
          case "mouseDown": {
            await runXtest({ action: "down", button: xtestButton(arm.value.button) });
            log.push("mouseDown");
            break;
          }
          case "mouseUp": {
            await runXtest({ action: "up", button: xtestButton(arm.value.button) });
            log.push("mouseUp");
            break;
          }
          case "drag": {
            const path = arm.value.path ?? [];
            if (path.length < 2) throw new LocalComputerUseError("drag needs a path with at least two points");
            const points = path.map(point => assertPoint(point.x, point.y));
            const start = points[0] ?? (() => { throw new LocalComputerUseError("drag needs a start point"); })();
            const button = xtestButton(arm.value.button);
            await runXtest({ action: "move", x: start.x, y: start.y });
            await runXtest({ action: "down", button });
            for (const point of points.slice(1)) await runXtest({ action: "move", x: point.x, y: point.y });
            await runXtest({ action: "up", button });
            log.push(`drag(${points.length} points)`);
            break;
          }
          case "scroll": {
            const point = assertPoint(arm.value.coordinate?.x, arm.value.coordinate?.y);
            const direction = arm.value.direction;
            const dirName = direction === 0 || direction === 1 ? (direction === 0 ? "up" : "down") : "down";
            const ticks = arm.value.amount > 0 ? Math.min(arm.value.amount, 20) : 1;
            await runXtest({ action: "scroll", x: point.x, y: point.y, dir: dirName, ticks });
            log.push(`scroll(${dirName}x${ticks} at ${point.x},${point.y})`);
            break;
          }
          case "type": {
            if (arm.value.text.length === 0) throw new LocalComputerUseError("type needs text");
            await runXtest({ action: "type", text: arm.value.text });
            log.push(`type(${arm.value.text.length} chars)`);
            break;
          }
          case "key": {
            if (arm.value.key.length === 0) throw new LocalComputerUseError("key needs a key name");
            await runXtest({ action: "key", key: arm.value.key });
            log.push(`key(${arm.value.key})`);
            break;
          }
          case "wait": {
            const bounded = Math.min(Math.max(arm.value.durationMs, 0), WAIT_CAP_MS);
            await delay(bounded);
            log.push(`wait(${bounded}ms)`);
            break;
          }
          case "screenshot": {
            const png = await captureDesktopPng();
            lastScreenshotPath = await persistScreenshot(png);
            lastScreenshotBase64 = png.toString("base64");
            log.push(`screenshot(${png.byteLength} bytes -> ${lastScreenshotPath})`);
            break;
          }
          case "cursorPosition":
            // XTEST can only fake input, not query it; saying so beats
            // inventing a position.
            throw new LocalComputerUseError("cursor position query is not available on the local desktop plane");
          default:
            throw new LocalComputerUseError(`unsupported action: ${String(armCase)}`);
        }
        completed += 1;
      }
      return new ComputerUseResultConstructor({
        result: {
          case: "success",
          value: new ComputerUseSuccess({
            actionCount: completed,
            durationMs: Date.now() - startedAt,
            ...(lastScreenshotBase64 == null ? {} : { screenshot: lastScreenshotBase64 }),
            ...(lastScreenshotPath == null ? {} : { screenshotPath: lastScreenshotPath }),
            ...(log.length === 0 ? {} : { log: log.join("\n") }),
          }),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new ComputerUseResultConstructor({
        result: {
          case: "error",
          value: new ComputerUseError({
            error: `local computer use failed after ${completed} action(s): ${message}`,
            actionCount: completed,
            durationMs: Date.now() - startedAt,
            ...(log.length === 0 ? {} : { log: log.join("\n") }),
            ...(lastScreenshotBase64 == null ? {} : { screenshot: lastScreenshotBase64 }),
            ...(lastScreenshotPath == null ? {} : { screenshotPath: lastScreenshotPath }),
          }),
        },
      });
    }
  },
};
