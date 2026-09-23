import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { build as esbuild } from "esbuild";

import { buildAsar } from "./build-asar.mjs";
import {
  buildProductionRenderer,
  rendererProductionEntrypoint,
  rendererProductionProvenance,
} from "../renderer-production-build.mjs";
import {
  buildDir,
  builtAsar,
  builtAsarUnpacked,
  repoRoot,
  stagedAppDir,
} from "./config.mjs";
import { packStagedAppWithIntegrity, verifyStagedPackageIntegrity } from "./asar-integrity.mjs";
import { officialMacReleaseAsarHash } from "./macos-shell-invariant.mjs";
import { stageNodeTreeSitterRuntime } from "../build-tree-sitter-node.mjs";
import { run } from "./process.mjs";
import { electronShell } from "./source-only-package.mjs";
import { buildProductionElectronMainIfSupplied } from "../electron-main-production-activation.mjs";
import { buildProductionHostIfSupplied } from "../host-production-activation.mjs";

export { packStagedAppWithIntegrity, verifyStagedPackageIntegrity } from "./asar-integrity.mjs";

export const cleanBuildDir = path.join(buildDir, "clean-runtime");
export const fidelityCleanBuildDir = path.join(buildDir, "fidelity-clean-runtime");
export const rendererArtifactProvenance = "dist/renderer-artifact-provenance.json";

const executableReplacements = [
  "dist/electron-dev-controls/main.cjs",
  "dist/electron-preload/preload.cjs",
  "dist/electron-preload/preload-dev-controls.cjs",
  "dist/electron-preload/preload-webview.cjs",
  "dist/electron-preload/preload-vnc.cjs",
  "dist/host/agent-isolation/agent-store-worker.cjs",
  "dist/host/agent-isolation/transcript-mirror-worker.cjs",
  "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs",
  "dist/host/extensions/content-search/search-index-worker.cjs",
  "dist/box-exec-daemon/main.cjs",
  "dist/local-exec-daemon/main.cjs",
  "dist/node-agent-coordinator/main.cjs",
  "dist/renderer",
];

const sourceLibraries = [
  ["source/electron-main/main.ts", "dist/recovered-source/electron-main/main.cjs"],
  ["source/host/main.ts", "dist/recovered-source/host/host-main.cjs"],
];

export const runtimeComposition = Object.freeze([
  { runtime: "electron-main", path: "dist/electron-main/main.cjs", mode: "artifact-fallback", sourceBundle: "dist/recovered-source/electron-main/main.cjs", reason: "The recovered production compositor is structurally complete, but clean activation requires an exact validated manifest for generated/backend adapters; Electron ABI values are supplied by the packaged shell." },
  { runtime: "electron-dev-controls", path: "dist/electron-dev-controls/main.cjs", mode: "clean-source", source: "source/electron-dev-controls/main.ts" },
  { runtime: "primary-preload", path: "dist/electron-preload/preload.cjs", mode: "clean-source", source: "source/electron-preload/preload.ts", entrypoint: "source/electron-preload/runtime/primary.ts" },
  { runtime: "dev-controls-preload", path: "dist/electron-preload/preload-dev-controls.cjs", mode: "clean-source", source: "source/electron-preload/preload-dev-controls.ts", entrypoint: "source/electron-preload/runtime/dev-controls.ts" },
  { runtime: "webview-preload", path: "dist/electron-preload/preload-webview.cjs", mode: "clean-source", source: "source/electron-preload/preload-webview.ts", entrypoint: "source/electron-preload/runtime/webview.ts" },
  { runtime: "vnc-preload", path: "dist/electron-preload/preload-vnc.cjs", mode: "clean-source", source: "source/electron-preload/preload-vnc.ts", entrypoint: "source/electron-preload/runtime/vnc.ts" },
  { runtime: "node-agent-coordinator", path: "dist/node-agent-coordinator/main.cjs", mode: "clean-source", source: "source/node-agent-coordinator/main.ts" },
  { runtime: "host", path: "dist/host/host-main.cjs", mode: "artifact-fallback", sourceBundle: "dist/recovered-source/host/host-main.cjs", reason: "Recovered host main requires concrete host factories and process bootstrap dependencies." },
  { runtime: "host-agent-store-worker", path: "dist/host/agent-isolation/agent-store-worker.cjs", mode: "clean-source", source: "source/host/agent-isolation/agent-store-worker.ts" },
  { runtime: "host-transcript-mirror-worker", path: "dist/host/agent-isolation/transcript-mirror-worker.cjs", mode: "clean-source", source: "source/host/agent-isolation/transcript-mirror-worker.ts" },
  { runtime: "host-box-store-vacuum-worker", path: "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs", mode: "clean-source", source: "source/host/extensions/box-store-sync/box-store-vacuum-worker.ts" },
  { runtime: "host-search-index-worker", path: "dist/host/extensions/content-search/search-index-worker.cjs", mode: "clean-source", source: "source/host/extensions/content-search/search-index-worker.ts" },
  { runtime: "box-exec-daemon", path: "dist/box-exec-daemon/main.cjs", mode: "clean-source", source: "source/box-exec-daemon/main.ts", entrypoint: "source/box-exec-daemon/cli.ts" },
  { runtime: "local-exec-daemon", path: "dist/local-exec-daemon/main.cjs", mode: "clean-source", source: "source/local-exec-daemon/main.ts" },
  { runtime: "renderer", path: "dist/renderer", mode: "clean-source", source: rendererProductionEntrypoint, entrypoint: rendererProductionEntrypoint, provenance: rendererProductionProvenance },
  { runtime: "electron-runtime-dependencies", path: "dist/deps", mode: "artifact-runtime", reason: "ABI-matched native and packaged dependencies are copied from the checksum-pinned 0.18 runtime." },
  { runtime: "electron-runtime-resolution-closure", path: "dist/deps/node_modules", mode: "generated-runtime", provenance: "dist/deps/runtime-deps-manifest.json", reason: "Byte-exact copies of checksum-pinned sibling packages provide standard Node package resolution for Electron utility-process native dependencies." },
  { runtime: "node-runtime-dependencies", path: "dist/node-deps", mode: "generated-runtime", reason: "Native parser packages are rebuilt for the local-exec daemon Node ABI at clean-build time; binaries are never source-controlled." },
  { runtime: "native-runtime-tools", path: "dist/native", mode: "artifact-runtime", reason: "ABI-matched native executables are copied from the checksum-pinned 0.18 runtime." },
  { runtime: "electron-shell", path: "Contents/Frameworks/Electron Framework.framework", mode: "artifact-runtime", reason: "The macOS package reuses the checksum-pinned, ABI-matched Electron 0.18 application shell and helper executables." },
]);

export const fidelityRuntimeComposition = Object.freeze(runtimeComposition.map(runtime => (
  runtime.runtime === "renderer" ? Object.freeze({
    runtime: "renderer",
    path: "dist/renderer",
    mode: "checksum-pinned-artifact-runtime",
    artifactRoot: "src/app/dist/renderer",
    provenance: rendererArtifactProvenance,
    reason: "The exact shipped 0.18 Mac renderer bundle is preserved byte-for-byte and accepted only against its complete embedded SHA-256 inventory.",
  }) : runtime
)));

// A source-only build records these two entrypoints as blocked until their
// production bindings are available from source. The recovered library bundles
// below are useful build evidence, but they do not start either process.
export const sourceOnlyRuntimeComposition = Object.freeze(runtimeComposition
  .filter(runtime => !["electron-runtime-resolution-closure", "native-runtime-tools", "electron-shell"].includes(runtime.runtime))
  .map(runtime => ["electron-main", "host"].includes(runtime.runtime)
    ? Object.freeze({ runtime: runtime.runtime, path: runtime.path, mode: "blocked-source-entrypoint", sourceBundle: runtime.sourceBundle, reason: "The source library builds, but mandatory production bindings and a runnable process entrypoint have not been established without shipped artifacts." })
    : runtime.runtime === "electron-runtime-dependencies"
      ? Object.freeze({ runtime: runtime.runtime, path: runtime.path, mode: "blocked-native-build", reason: "Packaged Electron shell command analysis loads tree-sitter and tree-sitter-bash from dist/deps; Electron 42 ABI builds must be staged from installed packages." })
    : runtime));

function nodeBuildOptions(outfile) {
  return {
    absWorkingDir: repoRoot,
    bundle: true,
    define: { "import.meta.url": "__cleanImportMetaUrl" },
    external: ["electron"],
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    minify: false,
    outfile,
    platform: "node",
    sourcemap: false,
    target: "node22",
  };
}

function nodeBanner(label) {
  return `const __cleanImportMetaUrl = require("node:url").pathToFileURL(__filename + ".bundled").href;\n// ${label}`;
}

async function bundleSource(entry, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await esbuild({
    ...nodeBuildOptions(outfile),
    entryPoints: [path.join(repoRoot, entry)],
    banner: { js: nodeBanner(`Deterministic clean-source bundle: ${entry}`) },
  });
}

async function bundlePreloadSource(entry, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await esbuild({
    ...nodeBuildOptions(outfile),
    define: {},
    entryPoints: [path.join(repoRoot, entry)],
    banner: { js: `// Deterministic clean-source preload bundle: ${entry}` },
  });
}

async function bundleVirtual(name, contents, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await esbuild({
    ...nodeBuildOptions(outfile),
    stdin: { contents, loader: "ts", resolveDir: repoRoot, sourcefile: `scripts/build-entry/${name}.ts` },
    banner: { js: nodeBanner(`Deterministic clean-source runtime adapter: ${name}`) },
  });
}

const coordinatorEntry = `
import { composeCoordinator } from "./source/node-agent-coordinator/main.ts";

void composeCoordinator().catch((error) => {
  process.stderr.write(\`node-agent-coordinator: composition failure: \${String(error)}\\n\`);
  process.exit(1);
});
`;

const localExecDaemonEntry = `
import { runLocalExecDaemonEntrypoint } from "./source/local-exec-daemon/main.ts";

void runLocalExecDaemonEntrypoint();
`;

async function walkFiles(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(root, target));
    else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return found.sort();
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

export async function stageSourceOnlyElectronTreeSitterRuntime(outputRoot) {
  const depsRoot = path.join(path.resolve(outputRoot), "dist/deps");
  await mkdir(depsRoot, { recursive: true });
  for (const name of ["tree-sitter", "tree-sitter-bash", "node-gyp-build"]) {
    await cp(path.join(repoRoot, "node_modules", name), path.join(depsRoot, name), { recursive: true, dereference: true });
  }
  await mkdir(path.join(depsRoot, "node_modules"), { recursive: true });
  await cp(path.join(depsRoot, "node-gyp-build"), path.join(depsRoot, "node_modules/node-gyp-build"), { recursive: true, dereference: true });
  const electronBinary = path.join(electronShell, "Contents/MacOS/Electron");
  const check = "const Parser=require(process.argv[1]+'/tree-sitter');const bash=require(process.argv[1]+'/tree-sitter-bash');const parser=new Parser();parser.setLanguage(bash);if(parser.parse('echo ok').rootNode.type!=='program')process.exit(2);if(process.versions.modules!=='146')process.exit(3)";
  try {
    await run(electronBinary, ["-e", check, depsRoot], { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  } catch (error) {
    throw new Error(`Source-only Electron native runtime is not loadable with Electron 42 ABI 146: ${String(error)}`);
  }
  return depsRoot;
}

export async function createRendererArtifactProvenance({
  artifactRoot = path.join(repoRoot, "src", "app", "dist", "renderer"),
} = {}) {
  const relativeRoot = path.relative(repoRoot, artifactRoot).split(path.sep).join("/");
  if (relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) {
    throw new Error(`Renderer artifact root must be inside the repository: ${artifactRoot}`);
  }
  const files = [];
  for (const relative of await walkFiles(artifactRoot)) {
    const target = path.join(artifactRoot, relative);
    files.push({ path: relative, bytes: (await stat(target)).size, sha256: await sha256(target) });
  }
  if (files.length === 0 || !files.some(file => file.path === "index.html")) {
    throw new Error(`Shipped renderer inventory is incomplete at ${artifactRoot}`);
  }
  const inventorySha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    schemaVersion: 1,
    upstreamVersion: "0.18.0",
    upstreamAppAsarSha256: officialMacReleaseAsarHash,
    mode: "checksum-pinned-artifact-runtime",
    artifactRoot: relativeRoot,
    hashAlgorithm: "sha256",
    fileCount: files.length,
    inventorySha256,
    files,
  };
}

export function packagedArtifactFallbacks(composition = runtimeComposition) {
  return composition
    .filter(({ mode, sourceBundle }) => mode === "artifact-fallback" && typeof sourceBundle === "string")
    .map(({ sourceBundle }) => sourceBundle);
}

async function buildRuntimeDistribution({ outputRoot, composition, rendererMode, sourceOnly = false }) {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  for (const [entry, output] of sourceLibraries) await bundleSource(entry, path.join(outputRoot, output));
  await bundleSource("source/electron-dev-controls/main.ts", path.join(outputRoot, "dist/electron-dev-controls/main.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/primary.ts", path.join(outputRoot, "dist/electron-preload/preload.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/dev-controls.ts", path.join(outputRoot, "dist/electron-preload/preload-dev-controls.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/webview.ts", path.join(outputRoot, "dist/electron-preload/preload-webview.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/vnc.ts", path.join(outputRoot, "dist/electron-preload/preload-vnc.cjs"));
  await bundleSource("source/host/agent-isolation/agent-store-worker.ts", path.join(outputRoot, "dist/host/agent-isolation/agent-store-worker.cjs"));
  await bundleSource("source/host/agent-isolation/transcript-mirror-worker.ts", path.join(outputRoot, "dist/host/agent-isolation/transcript-mirror-worker.cjs"));
  await bundleSource("source/host/extensions/box-store-sync/box-store-vacuum-worker.ts", path.join(outputRoot, "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs"));
  await bundleSource("source/host/extensions/content-search/search-index-worker.ts", path.join(outputRoot, "dist/host/extensions/content-search/search-index-worker.cjs"));
  await run(process.execPath, [
    path.join(repoRoot, "scripts/build-box-exec-daemon.mjs"),
    path.join(outputRoot, "dist/box-exec-daemon/main.cjs"),
  ], { cwd: repoRoot });
  await bundleVirtual("local-exec-daemon", localExecDaemonEntry, path.join(outputRoot, "dist/local-exec-daemon/main.cjs"));
  await stageNodeTreeSitterRuntime(outputRoot);
  if (sourceOnly && process.platform === "darwin") {
    await stageSourceOnlyElectronTreeSitterRuntime(outputRoot);
    composition = composition.map(runtime => runtime.runtime === "electron-runtime-dependencies"
      ? { runtime: runtime.runtime, path: runtime.path, mode: "generated-runtime", source: "node_modules/tree-sitter + node_modules/tree-sitter-bash", verifiedElectronAbi: 146 }
      : runtime);
  }
  await bundleVirtual("node-agent-coordinator", coordinatorEntry, path.join(outputRoot, "dist/node-agent-coordinator/main.cjs"));
  let renderer;
  if (rendererMode === "clean-source") {
    renderer = await buildProductionRenderer({ outputRoot });
  } else if (rendererMode === "checksum-pinned-artifact-runtime") {
    renderer = await createRendererArtifactProvenance();
    const provenancePath = path.join(outputRoot, rendererArtifactProvenance);
    await mkdir(path.dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, `${JSON.stringify(renderer, null, 2)}\n`);
  } else {
    throw new Error(`Unsupported renderer runtime mode: ${rendererMode}`);
  }

  const files = await walkFiles(outputRoot);
  const outputs = [];
  for (const name of files) outputs.push({ path: name, bytes: (await stat(path.join(outputRoot, name))).size, sha256: await sha256(path.join(outputRoot, name)) });
  const buildManifest = {
    schemaVersion: 1,
    upstreamVersion: "0.18.0",
    buildKind: sourceOnly ? "source-only-components" : rendererMode === "clean-source" ? "source-aware-reconstruction" : "fidelity-hybrid-reconstruction",
    deterministicInputs: [
      "source",
      ...(rendererMode === "clean-source" ? [
        "frontend/src",
        "frontend/manifests/renderer-bootstrap.json",
        "frontend/manifests/renderer-runtime-assets.json",
        "frontend/manifests/ui-evidence-anchors.json",
        "manifests/reconstruction/renderer-closure.json",
      ] : ["src/app/dist/renderer"]),
    ],
    runtimeComposition: composition,
    outputs,
  };
  const manifestPath = path.join(outputRoot, "dist", "reconstruction-build.json");
  await writeFile(manifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);
  return { outputRoot, manifestPath, buildManifest, renderer };
}

export async function buildCleanDistribution({ outputRoot = cleanBuildDir } = {}) {
  return buildRuntimeDistribution({ outputRoot, composition: runtimeComposition, rendererMode: "clean-source" });
}

export async function buildSourceOnlyDistribution({ outputRoot = path.join(buildDir, "source-only-components") } = {}) {
  const base = await buildRuntimeDistribution({ outputRoot, composition: sourceOnlyRuntimeComposition, rendererMode: "clean-source", sourceOnly: true });
  const [electronMain, host] = await Promise.all([
    buildProductionElectronMainIfSupplied({ outputRoot, manifestPath: null, reconstructedPackage: true, sourceOnly: true }),
    buildProductionHostIfSupplied({ outputRoot, manifestPath: null, sourceOnly: true }),
  ]);
  if (!electronMain.clean || !host.clean) {
    throw new Error(`Source-only production activation is incomplete: electron-main=${electronMain.blocker ?? electronMain.status}; host=${host.blocker ?? host.status}`);
  }
  const composition = base.buildManifest.runtimeComposition.map(runtime => runtime.runtime === "electron-main" || runtime.runtime === "host"
    ? { runtime: runtime.runtime, path: runtime.path, mode: "clean-source", source: `source/${runtime.runtime === "host" ? "host" : "electron-main"}/main.ts` }
    : runtime);
  const outputs = [];
  for (const relative of await walkFiles(outputRoot)) {
    if (relative === "dist/reconstruction-build.json") continue;
    outputs.push({ path: relative, bytes: (await stat(path.join(outputRoot, relative))).size, sha256: await sha256(path.join(outputRoot, relative)) });
  }
  const buildManifest = {
    ...base.buildManifest,
    deterministicInputs: [...base.buildManifest.deterministicInputs, "package.json", "package-lock.json", "scripts/electron-main-production-activation.mjs", "scripts/host-production-activation.mjs", "node_modules/electron"],
    runtimeComposition: composition,
    outputs,
  };
  await writeFile(base.manifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);
  return { ...base, buildManifest, electronMainActivation: electronMain, hostActivation: host };
}

export async function buildFidelityDistribution({ outputRoot = fidelityCleanBuildDir } = {}) {
  return buildRuntimeDistribution({ outputRoot, composition: fidelityRuntimeComposition, rendererMode: "checksum-pinned-artifact-runtime" });
}

export async function overlayCleanDistribution(outputRoot, { stageRoot = stagedAppDir, composition = runtimeComposition } = {}) {
  const rendererMode = composition.find(runtime => runtime.runtime === "renderer")?.mode;
  for (const relative of executableReplacements.filter(relative => relative !== "dist/renderer" || rendererMode === "clean-source")) {
    const destination = path.join(stageRoot, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(outputRoot, relative), destination, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  for (const relative of [...packagedArtifactFallbacks(composition), "dist/node-deps", "dist/reconstruction-build.json"]) {
    const destination = path.join(stageRoot, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(outputRoot, relative), destination, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  if (rendererMode === "checksum-pinned-artifact-runtime") {
    const destination = path.join(stageRoot, rendererArtifactProvenance);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(outputRoot, rendererArtifactProvenance), destination, { preserveTimestamps: true });
  }
}

export async function buildReconstructedAsar({ pack = true } = {}) {
  const fallback = await buildAsar({ pack: false });
  const clean = await buildCleanDistribution();
  await overlayCleanDistribution(clean.outputRoot);
  if (pack) {
    await packStagedAppWithIntegrity({ stageRoot: stagedAppDir, archivePath: builtAsar, unpackedRoot: builtAsarUnpacked });
    console.log(`Source-aware ASAR ready: ${builtAsar}`);
  }
  console.log("Executable clean replacements: renderer, coordinator, box exec-daemon, local-exec daemon, primary/dev-controls/webview/VNC preloads, and four host workers.");
  return { ...fallback, ...clean };
}
