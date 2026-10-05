export interface LocalExecProcessIdentity { readonly pid: number; readonly startEpochMs: number; readonly command: string; }
export interface ProcessIdentityReadOptions { readonly signal?: AbortSignal }
export interface ProcessTerminateOptions { readonly expectedIdentity?: LocalExecProcessIdentity; readonly kill?: typeof process.kill }
export interface LocalExecProcessAdapter {
  readIdentity(pid: number, options?: ProcessIdentityReadOptions): Promise<LocalExecProcessIdentity | null>;
  readState(pid: number): string | null;
  terminate(pid: number, options?: ProcessTerminateOptions): Promise<void>;
}
