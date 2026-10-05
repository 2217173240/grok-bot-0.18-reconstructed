export interface LocalRuntimeOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; homeDir?: string; dataRoot?: string; }
export type DockerProfile = { kind: "host"; value: string; source: string } | { kind: "context"; value: string | undefined; source: string };
export interface LocalDockerPlatform { readonly image: string; readonly dockerPlatform: "linux/arm64" | "linux/amd64"; readonly dataVolume: string; }
export function localDockerPlatform(platform?: NodeJS.Platform, arch?: string): LocalDockerPlatform;
export interface LocalRuntimeProfile { readonly host: { readonly platform: NodeJS.Platform; readonly arch: string }; readonly dataRoot: string; readonly docker: Readonly<DockerProfile>; readonly container: { readonly platform: "linux/arm64" | "linux/amd64"; readonly image: string; readonly dataVolume: string }; readonly sources: Readonly<{dataRoot: string; image: string}>; }
export function resolveLocalRuntimeProfile(options?: LocalRuntimeOptions): LocalRuntimeProfile;
export function resolveLocalDataRoot(options?: LocalRuntimeOptions): string;
export function validateDockerRuntime(profile: LocalRuntimeProfile, info: unknown): boolean;
export function dockerEnvironment(profile: LocalRuntimeProfile, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function validateDockerImage(profile: LocalRuntimeProfile, image: unknown, expectedDepsPin: string | undefined): void;
