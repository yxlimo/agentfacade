# The code is baked into the image. The NAS never gets a checkout: this file is
# built locally, exported as a tar, and `docker load`ed on the other side.
#
# Three stages: the panel and the runtime dependencies are built with node + pnpm,
# the runtime only carries the results. The router runs the .ts files directly with
# native type stripping (>= 22.6), so there is no build step for the backend.
#
# 底座用 nicklpeterson/pnpm-node，而不是 node + corepack：corepack 会在**构建容器里**
# 从 npm registry 下 pnpm 的独立二进制包（@pnpm/exe.*，25 MB 量级）。这台机器上构建
# 容器下大文件会卡死（实测 13 KB/s 量级，corepack 900 秒超时），冷缓存时镜像根本建
# 不出来。pnpm-node 是 node 官方镜像加上预装的 pnpm，拉一次就有，构建里不再下 pnpm。
# tag 是「node 主版本-pnpm 版本-发行版」，这里的 pnpm 版本必须与 package.json 的
# packageManager 一致，否则 pnpm 会因为它自己不是那个版本而拒绝干活。

# ── 面板 ──────────────────────────────────────────────────────────────────
FROM docker.io/nicklpeterson/pnpm-node:24-12.16.1-bookworm AS web

WORKDIR /build

# 面板自己的依赖。
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN cd web && pnpm install --frozen-lockfile

COPY web/ ./web/
# 契约的生成物在仓库的 lib/gen/ 里。面板构建前把它搬进 web/.gen/（web/scripts/
# copy-gen.mjs），这样它的依赖从 web/node_modules 里找，容器里就不用再装一遍
# 根目录的依赖。来源仍然只有 lib/gen/ 一处。
COPY lib/gen/ ./lib/gen/

RUN cd web && pnpm build

# ── 运行时依赖 ────────────────────────────────────────────────────────────
# 单独一层：运行时镜像不带 pnpm、不带 devDependencies。
FROM docker.io/nicklpeterson/pnpm-node:24-12.16.1-bookworm AS deps

WORKDIR /deps

# pnpm-workspace.yaml 要一起 COPY：lockfile 里记着 settings.addMissingPeerTypes
# （来自这个文件），容器里的 pnpm 会严格比对，缺了文件就报
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH。
#
# 但虚拟仓库类型要用命令行覆盖成 project：文件里写的是 global，node_modules 里
# 就只剩指向 store 的符号链接，而 store 在 /root/.local/share/pnpm（drwx------），
# 运行用户是 node(1000) 进不去，容器一启动就是 ERR_MODULE_NOT_FOUND。
# project 布局把包装进本目录 .pnpm/，镜像自包含（2026-10-30 实测）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --config.virtualStoreType=project

# ── 运行时 ────────────────────────────────────────────────────────────────
FROM docker.io/library/node:24-bookworm-slim

# The identity of the image: which commit, which version this code is.
#
# ARG belongs to this stage: an ARG only reaches the stages below the one that
# declares it, so an ARG at the top of the file would not be visible here.
#
# These two labels are the only record of which code is in the image.
# tools/verify-image.ts compares them with git rev-parse HEAD and with the
# version in package.json; a mismatch means the image was not built from this
# worktree. mise passes the two values in as --build-arg.
ARG GIT_REVISION=unknown
ARG APP_VERSION=0.0.0
LABEL org.opencontainers.image.revision=$GIT_REVISION
LABEL org.opencontainers.image.version=$APP_VERSION

WORKDIR /app

COPY --from=deps /deps/node_modules ./node_modules
COPY package.json ./

# Only what the router actually loads: the entry point and lib/. There is no login
# program: the router runs the device flow itself when a credential is missing.
# config-cli.ts is the way to look at and change the settings in the database.
COPY router-proxy.ts config-cli.ts ./
COPY lib/ ./lib/

# The panel: static files the router serves under /admin.
COPY --from=web /build/web/dist/ ./web/dist/

# The OAuth session is a credential, not configuration: it lives in a named volume
# mounted at /data, so a container rebuild does not lose the login. Created here with
# the runtime user's ownership, otherwise a fresh volume is root-owned and unwritable.
RUN mkdir -p /data && chown node:node /data

# 生成物里没有 enum：buf generate 用 erasable_syntax=true，把 protobuf 的枚举写成
# `as const` 对象加同名类型别名，原生「只剥类型」直接能跑（见 buf.gen.yaml）。
# 所以运行时不需要 transform-types；那个 flag 在 Node 26 上已经被删掉了。
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"

EXPOSE 6450

# The check reads the port from the environment, so the same image can serve on
# whichever port it is given. It reads the router's own variable: the health
# check and the service must not disagree about where the service listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "const p=process.env.ROUTER_PORT||6450;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "router-proxy.ts"]