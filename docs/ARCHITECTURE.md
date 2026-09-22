# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

The upstream 0.18.0 application is an external, checksum-pinned build input.
`npm run bootstrap` extracts its `dist` tree to ignored `src/app/dist`. Build
scripts stage that baseline, compile reviewed source runtimes, overlay eligible
clean outputs, apply the reconstructed updater guard, and pack a new ASAR.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.

## Renderer artifact layers

The renderer exists in three places, and only the last one is delivered:

1. `src/app/dist/renderer` is the 0.18 baseline extracted by `npm run bootstrap`.
   It is a build input and read-only evidence.
2. `frontend/src/recovered` is a readable reconstruction derived from the
   baseline. It documents behavior, and edits here do not reach the delivered
   application.
3. `.build/fidelity/app/dist/renderer` is the stage that
   `buildFidelityReconstructedAsar` (`scripts/clean-build.mjs`) assembles: it
   copies the baseline, overlays the eligible clean outputs, and applies the
   reconstruction patches. The ASAR packs this stage, so the delivered renderer
   is the patched result.

A reconstruction change that must alter delivered renderer behavior therefore
belongs in a packaging patch. `scripts/lib/router-renderer-patch.mjs` holds
them, applies each edit through `replaceExactlyOnce` so that a moved anchor
fails the build, and records the before/after byte counts and SHA-256 of every
patched chunk in `dist/renderer-router-extension.json`.

## Transcript entry text field

The host stores an ordinary message body as `content`
(`source/host/extensions/transcript/send-message-shaping.ts`), while the
delivered renderer's own projection writes `text`
(`frontend/src/production/model.ts`, `projectTranscriptEntry`). Both field
names carry the same value, and a reader on either side must accept both.

`source/host/extensions/transcript/renderer-entry-shape.ts` projects entries
into the renderer field name as they leave the host, adding `text` while
keeping `content`. Every host exit path routes through it: the transcript
commands in `source/host/host-gateway-api.ts` and the event emitter in
`source/host/extensions/transcript/roster-projection.ts`.
