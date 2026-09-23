# arm64-native exec lab: the Archive desktop/toolchain image as the base, plus
# this repo's runtime dependencies installed for linux/arm64 so the staged
# v2 host and the reconstructed box-exec-daemon run natively (no QEMU).
#
# Build:  see docker/build-arm64-box.sh
# Run:    see docker/run-arm64-box.sh (bind-mounts the v3 staged runtime)
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
LABEL org.opencontainers.image.base.name="${BASE_IMAGE}"

# The host bundle requires the node:sqlite builtin (Node >= 22.5); the base
# image's apt Node is 20. Install the official arm64 binary over it, pinned
# and checksummed like the base image's bun/uv layers (release assets can be
# replaced upstream; TLS alone does not make a build reproducible).
ARG NODE_VERSION=v22.23.2
ARG NODE_SHA256=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
USER root
RUN set -eux; \
    mkdir -p /home/box/.cache/grok-build; \
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz" -o /home/box/.cache/grok-build/node.tar.xz; \
    echo "${NODE_SHA256}  /home/box/.cache/grok-build/node.tar.xz" | sha256sum -c -; \
    tar -xJf /home/box/.cache/grok-build/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /home/box/.cache/grok-build/node.tar.xz; \
    chown box:box /home/box/.cache /home/box/.cache/grok-build; \
    node --version; node -e "require('node:sqlite'); console.log('node:sqlite available')"
USER box

# Runtime externals for host-main.cjs / box-exec-daemon/main.cjs. npm ci with
# the repo lockfile resolves linux/arm64 prebuilds where they exist and
# compiles the rest (tree-sitter family) with the image's gcc. The postinstall
# patch script ships along — it sha-pins third-party fixes (including the
# tree-sitter binding.gyp tweak the native build needs).
COPY --chown=box:box package.json package-lock.json /home/box/.cache/grok-build/runtime-deps/
COPY --chown=box:box scripts/apply-third-party-patches.mjs /home/box/.cache/grok-build/runtime-deps/scripts/
RUN cd /home/box/.cache/grok-build/runtime-deps && TMPDIR=/home/box/.cache/grok-build npm ci --omit=dev --silent \
    && mkdir -p /home/box/deps \
    && cp -R node_modules /home/box/deps/node_modules \
    && rm -rf /home/box/.cache/grok-build/runtime-deps \
    && node -e "require('/home/box/deps/node_modules/tree-sitter'); console.log('tree-sitter loads natively')"

# Mount points matching the official image layout the connector expects:
#   /home/box/sand-host/host-main.cjs   (bind, from local-docker-runtime v3-*)
#   /home/box/box-exec-daemon/          (bind, ditto)
# The host spawns the daemon itself when SAND_USE_EXISTING_BOX_EXEC_DAEMON is
# unset, so the container needs no supervisor for the exec plane.
RUN mkdir -p /home/box/sand-host /home/box/box-exec-daemon /home/box/sand-data /home/box/workspace

ENV NODE_PATH=/home/box/deps/node_modules \
    SAND_TREE_SITTER_NODE_DEPS=/home/box/deps/node_modules

# The exec-variant entrypoint (desktop plane in the background, host as the
# foreground via exec) and the XTEST input helper for the Computer tool — see
# docs/ROADMAP.md B1/B3. Placed after the npm ci layer so editing these does
# not invalidate the expensive dependency layer.
COPY --chown=box:box docker/bin/box-init-exec /usr/local/bin/box-init-exec
COPY --chown=box:box docker/bin/xtest-input-local.py /usr/local/bin/xtest-input-local.py
COPY --chown=box:box docker/bin/box-navigate /usr/local/bin/box-navigate
USER root
RUN chmod 0755 /usr/local/bin/box-init-exec /usr/local/bin/xtest-input-local.py /usr/local/bin/box-navigate
USER box

# Keep the Archive entrypoint (desktop on the main display); the gateway and
# daemon are spawned by the bind-mounted host process, not by the image.
# The connector overrides the entrypoint per mode: box-init-exec when
# SAND_LOCAL_ADMIN_DESKTOP=1 (schema 9+), node otherwise.
CMD ["/usr/local/bin/box-init"]
