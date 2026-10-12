import { constants, existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorMessage } from "../../../shared/errors.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { DB_BUSY_TIMEOUT_MS } from "../../storage/store-db.js";
import {
  BOX_STORE_BLOBS_PREFIX,
  isBoxStoreManifestFileEntry,
  type BoxStoreManifestEntry,
} from "./box-store-manifest-format.js";
import type { BoxManifestMap, BoxStoreManifestStore } from "./box-store-manifest.js";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.js";
import { sqliteVacuumInto } from "./sqlite-snapshot.js";

export type SnapshotUploadResult = {
  readonly outcome: "uploaded" | "unchanged" | "oversize" | "error";
  readonly bytesUploaded: number;
  readonly blobUploadDurationMs: number;
  readonly failurePhase?: "capture" | "blob_upload";
};

export class StoreDbSnapshotUpload {
  private readonly objectStoreProvider: BoxObjectStoreProvider;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly maxObjectBytes: number;
  private readonly largeObjectThreshold: number;
  private vacuumWorkerAvailable: boolean | undefined;

  constructor(args: {
    objectStoreProvider: BoxObjectStoreProvider;
    now: () => number;
    log: (message: string) => void;
    manifestStore: BoxStoreManifestStore;
    maxObjectBytes: number;
    largeObjectThreshold: number;
  }) {
    this.objectStoreProvider = args.objectStoreProvider;
    this.now = args.now;
    this.log = args.log;
    this.manifestStore = args.manifestStore;
    this.maxObjectBytes = args.maxObjectBytes;
    this.largeObjectThreshold = args.largeObjectThreshold;
  }

  objectStore(storeId: string): BoxObjectStore {
    return this.objectStoreProvider.forStore(storeId);
  }

  elapsedDurationMs(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  async uploadAgentDbSnapshot(
    storeId: string,
    manifest: BoxManifestMap,
    relPath: string,
    snapshotPath: string,
    mode: number,
  ): Promise<SnapshotUploadResult> {
    // 原快照位于 agent 可写的 DB 目录。只打开一次，复制至独占 0700 临时目录，
    // 哈希与上传均使用该副本；避免对象存储稍后重新打开 agent 的原路径。
    // 该副本不隔离有权替换临时目录祖先路径的同 UID 进程。
    let staging: string;
    try { staging = await mkdtemp(join(tmpdir(), "store-db-upload-")); }
    catch (error) {
      this.log(`snapshot staging failed ${relPath}: ${errorMessage(error)}`);
      return { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" };
    }
    try {
      const stablePath = join(staging, "snapshot");
      let size = 0;
      let sha: string;
      let bytes: Buffer | undefined;
      try {
        const input = await open(snapshotPath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
        try {
          if (!(await input.stat()).isFile()) throw new Error("Snapshot must be a regular file");
          const output = await open(stablePath, "wx", 0o600);
          try {
            const hash = createHash("sha256");
            const chunk = Buffer.alloc(64 * 1024);
            while (true) {
              const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, this.maxObjectBytes - size + 1), size);
              if (bytesRead === 0) break;
              size += bytesRead;
              if (size > this.maxObjectBytes) return { outcome: "oversize", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" };
              const data = chunk.subarray(0, bytesRead);
              hash.update(data);
              await output.writeFile(data);
            }
            sha = hash.digest("hex");
          } finally { await output.close(); }
        } finally { await input.close(); }
        if (size < this.largeObjectThreshold) bytes = await readFile(stablePath);
      } catch (error) {
        this.log(`read failed ${relPath}: ${errorMessage(error)}`);
        return {
          outcome: "error",
          bytesUploaded: 0,
          blobUploadDurationMs: 0,
          failurePhase: "capture",
        };
      }

      const entry: BoxStoreManifestEntry = { kind: "file", sha, size, mode: mode & 0o777 };
      const existing = manifest.get(relPath);
      if (existing != null
        && isBoxStoreManifestFileEntry(existing)
        && existing.sha === sha
        && existing.size === size) {
        this.manifestStore.setManifestEntry(manifest, relPath, entry);
        return { outcome: "unchanged", bytesUploaded: 0, blobUploadDurationMs: 0 };
      }

      const uploadStartedAt = this.now();
      try {
        if (bytes === undefined) {
          await this.objectStore(storeId).putFromFile!(
            `${BOX_STORE_BLOBS_PREFIX}/${sha}`,
            stablePath,
            sha,
            size,
          );
        } else {
          await this.objectStore(storeId).put(
            `${BOX_STORE_BLOBS_PREFIX}/${sha}`,
            bytes,
            { contentAddressed: true },
          );
        }
      } catch (error) {
        this.log(`upload failed ${relPath}: ${errorMessage(error)}`);
        return {
          outcome: "error",
          bytesUploaded: 0,
          blobUploadDurationMs: this.elapsedDurationMs(uploadStartedAt),
          failurePhase: "blob_upload",
        };
      }
      this.manifestStore.setManifestEntry(manifest, relPath, entry);
      return {
        outcome: "uploaded",
        bytesUploaded: size,
        blobUploadDurationMs: this.elapsedDurationMs(uploadStartedAt),
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(error => this.log(`snapshot staging cleanup failed ${relPath}: ${errorMessage(error)}`));
    }
  }

  async runVacuumOffThread(args: { srcPath: string; destPath: string }): Promise<void> {
    const entry = defaultVacuumWorkerEntryPath();
    if (this.vacuumWorkerAvailable === undefined) {
      this.vacuumWorkerAvailable = existsSync(entry);
      if (!this.vacuumWorkerAvailable) {
        this.log(`vacuum worker bundle absent (${entry}); using in-process VACUUM`);
      }
    }
    if (this.vacuumWorkerAvailable) {
      try {
        await runVacuumInWorker({
          entryPath: entry,
          srcPath: args.srcPath,
          destPath: args.destPath,
          busyTimeoutMs: DB_BUSY_TIMEOUT_MS,
        });
        return;
      } catch (error) {
        if (!(error instanceof VacuumWorkerUnavailableError)) throw error;
        this.vacuumWorkerAvailable = false;
        this.log(`vacuum worker unavailable; using in-process VACUUM: ${errorMessage(error)}`);
      }
    }
    await this.discardSnapshotTemp({ tmpPath: args.destPath, label: "vacuum fallback pre-clean" });
    sqliteVacuumInto(args.srcPath, args.destPath);
  }

  async discardSnapshotTemp(args: { tmpPath: string; label: string }): Promise<void> {
    try {
      await unlink(args.tmpPath);
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return;
      this.log(`temp cleanup failed ${args.label}: ${errorMessage(error)}`);
    }
  }
}

function defaultVacuumWorkerEntryPath(): string {
  const hostBundleDirectory =
    typeof __dirname === "string"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  return join(
    hostBundleDirectory,
    "extensions/box-store-sync/box-store-vacuum-worker.cjs",
  );
}

class VacuumWorkerUnavailableError extends Error {}

function runVacuumInWorker(args: {
  entryPath: string;
  srcPath: string;
  destPath: string;
  busyTimeoutMs: number;
}): Promise<void> {
  const { entryPath, srcPath, destPath, busyTimeoutMs } = args;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(entryPath);
    } catch (error) {
      reject(new VacuumWorkerUnavailableError(errorMessage(error)));
      return;
    }
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      run();
    };
    worker.on("message", (message: { ok?: boolean; message?: string }) => {
      if (message?.ok === true) finish(resolve);
      else finish(() => reject(new Error(message?.message ?? "vacuum worker reported failure")));
    });
    worker.on("error", (error) => {
      finish(() => reject(new VacuumWorkerUnavailableError(errorMessage(error))));
    });
    worker.on("exit", (code) => {
      finish(() => reject(new VacuumWorkerUnavailableError(
        `vacuum worker exited (${code}) before completing`,
      )));
    });
    worker.postMessage({ srcPath, destPath, busyTimeoutMs });
  });
}
