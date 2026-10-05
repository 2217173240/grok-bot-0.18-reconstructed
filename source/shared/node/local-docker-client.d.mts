import type { LocalRuntimeOptions, LocalRuntimeProfile } from "./local-runtime-profile.mjs";
export interface DockerCommandResult { readonly ok: boolean; readonly output: string; }
export interface LocalDockerClient {
  profile(): Promise<LocalRuntimeProfile>;
  run(args: readonly string[]): Promise<DockerCommandResult>;
  inspect(): Promise<LocalRuntimeProfile>;
}
export function createLocalDockerClient(options?: LocalRuntimeOptions): LocalDockerClient;
