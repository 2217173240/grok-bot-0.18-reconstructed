# 复用基础镜像的桌面与开发工具，按目标 Linux 架构安装 Node 和运行依赖。
# 构建入口：node docker/build-box.mjs --platform linux/arm64|linux/amd64。
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
# The script builds FROM a local tag of the verified base (some builders can't
# resolve a digest reference to a locally loaded image); the label keeps the
# pinned digest reference.
ARG BASE_IMAGE_REF=${BASE_IMAGE}
LABEL org.opencontainers.image.base.name="${BASE_IMAGE_REF}"

# host 使用 node:sqlite；两个平台安装同版本官方 Node，并核对官方 SHA-256。
ARG NODE_VERSION=v22.23.2
ARG TARGETARCH
USER root
RUN set -eux; \
    case "$TARGETARCH" in \
      arm64) NODE_ARCH=arm64; NODE_SHA256=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8 ;; \
      amd64) NODE_ARCH=x64; NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /home/box/.cache/grok-build; \
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /home/box/.cache/grok-build/node.tar.xz; \
    echo "${NODE_SHA256}  /home/box/.cache/grok-build/node.tar.xz" | sha256sum -c -; \
    tar -xJf /home/box/.cache/grok-build/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /home/box/.cache/grok-build/node.tar.xz; \
    chown box:box /home/box/.cache /home/box/.cache/grok-build; \
    node --version; node -e "require('node:sqlite'); console.log('node:sqlite available')"
USER box

# npm ci 按目标架构安装 lockfile 中的依赖，使用镜像中的 gcc 编译原生扩展。
# postinstall 脚本校验并应用 tree-sitter 等第三方修正。
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
COPY docker/bin/seed-local-settings.cjs /usr/local/bin/seed-local-settings.cjs
USER root
RUN chmod 0755 /usr/local/bin/box-init-exec /usr/local/bin/xtest-input-local.py /usr/local/bin/box-navigate
USER box

# Keep the Archive entrypoint (desktop on the main display); the gateway and
# daemon are spawned by the bind-mounted host process, not by the image.
# The connector overrides the entrypoint per mode: box-init-exec when
# SAND_LOCAL_ADMIN_DESKTOP=1 (schema 9+), node otherwise.
CMD ["/usr/local/bin/box-init"]
