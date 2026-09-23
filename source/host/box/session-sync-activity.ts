import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SESSION_SYNC_ACTIVITY_HEARTBEAT_MS = 3_000;

export class SessionSyncActivity {
  private busy = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private publishedFile: { dev: number; ino: number } | undefined;

  constructor(private readonly file: string) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.publish();
    this.timer = setInterval(() => this.publish(), SESSION_SYNC_ACTIVITY_HEARTBEAT_MS);
    this.timer.unref();
  }

  setBusy(value: boolean): void {
    if (this.stopped) return;
    this.busy = value;
    this.publish();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.publishedFile === undefined) return;
    const current = lstatSync(this.file, { throwIfNoEntry: false });
    if (current?.dev === this.publishedFile.dev && current.ino === this.publishedFile.ino) rmSync(this.file);
    this.publishedFile = undefined;
  }

  private publish(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, state: this.busy ? "busy" : "idle", updatedAt: Date.now(), pid: process.pid }), { mode: 0o600, flag: "wx" });
      const published = lstatSync(temporary);
      renameSync(temporary, this.file);
      this.publishedFile = { dev: published.dev, ino: published.ino };
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
