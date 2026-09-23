import { buildSourceOnlyDistribution } from "./lib/clean-build.mjs";

const result = await buildSourceOnlyDistribution();
console.log(`Source-only components: ${result.outputRoot}`);
const blocked = result.buildManifest.runtimeComposition.filter(item => item.mode.startsWith("blocked-"));
if (blocked.length > 0) throw new Error(`Source-only build has unresolved runtimes: ${blocked.map(item => `${item.runtime}: ${item.reason}`).join("; ")}`);
