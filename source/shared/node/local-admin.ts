export const SAND_LOCAL_ADMIN_ENV = "SAND_LOCAL_ADMIN";
export const LOCAL_ADMIN_AUTH_ID = "local-admin";
export const LOCAL_ADMIN_EMAIL_DEFAULT = "admin@local";

export function isLocalAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SAND_LOCAL_ADMIN_ENV] === "1";
}

export function localAdminEmail(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_LOCAL_ADMIN_EMAIL?.trim();
  return configured != null && configured.length > 0 ? configured : LOCAL_ADMIN_EMAIL_DEFAULT;
}

export function isCursorProductionBackendUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".lclhst.build")) return false;
    // The zero-remote contract covers both remote families the goal names
    // (cursor and xai). No xai call sites exist in this tree today; they are
    // listed anyway so a future one is blocked by the guard from day one
    // instead of being discovered by egress.
    return hostname === "api2.cursor.sh"
      || hostname === "api3.cursor.sh"
      || hostname === "authenticator.cursor.sh"
      || hostname === "cursor.com"
      || hostname.endsWith(".cursor.sh")
      || hostname.endsWith(".cursor.com")
      || hostname === "x.ai"
      || hostname.endsWith(".x.ai")
      || hostname === "grok.com"
      || hostname.endsWith(".grok.com");
  } catch {
    return false;
  }
}

export function assertLocalAdminNotProductionRpc(url: string, operation: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isLocalAdminEnabled(env)) return;
  if (!isCursorProductionBackendUrl(url)) return;
  throw new Error(`SAND_LOCAL_ADMIN forbids ${operation} against ${url}`);
}

export function createLocalAdminAccessToken(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: LOCAL_ADMIN_AUTH_ID,
    email: localAdminEmail(env),
    exp: Math.floor(nowMs / 1_000) + 10 * 365 * 24 * 60 * 60,
  })).toString("base64url");
  return `${header}.${payload}.local`;
}

export function localAdminProfile(env: NodeJS.ProcessEnv = process.env): {
  readonly email: string;
  readonly displayName: "Local admin";
  readonly isAnysphereUser: false;
} {
  return { email: localAdminEmail(env), displayName: "Local admin", isAnysphereUser: false };
}
