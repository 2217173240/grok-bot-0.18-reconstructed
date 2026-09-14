import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { validateBoxSecrets } from "../box-secrets.js";

export const BOX_SECRETS_FILENAME = "box-secrets.json";
export const BOX_SECRETS_STORE_VERSION = 1;

export class BoxSecretsSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxSecretsSnapshotValidationError";
  }
}

export function serializeBoxSecretsSnapshot(secrets: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({ version: BOX_SECRETS_STORE_VERSION, secrets })}\n`;
}

export function parseBoxSecretsSnapshot(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const persisted = value as Record<string, unknown>;
  const secrets = persisted.secrets;
  if (persisted.version !== BOX_SECRETS_STORE_VERSION || typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(secrets)) {
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
}

export async function persistBoxSecretsSnapshot(
  storePath: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const validationError = validateBoxSecrets(secrets);
  if (validationError != null) throw new BoxSecretsSnapshotValidationError(validationError);
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeBoxSecretsSnapshot(secrets), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, storePath);
    await chmod(storePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
