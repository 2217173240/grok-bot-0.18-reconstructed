// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L34
// The shipped bundle resolves these asset names relative to its own emitted
// module URL. Development serves the checked repository assets directly.
export function rendererRuntimeAssetUrl(file: string): string {
  const base = import.meta.env?.DEV === true
    ? new URL("/renderer-assets/", window.location.href)
    : new URL("./", import.meta.url);
  return new URL(file, base).href;
}
