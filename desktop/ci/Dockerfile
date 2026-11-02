# Build image of the Linux and Windows legs of scripts/ci-local.sh (always built with --platform linux/amd64, so an
# Apple Silicon Mac runs it under Rosetta in OrbStack/Docker Desktop). The macOS legs run on the
# host. Built by ci-local.sh with the versions below taken from the repo; the defaults only
# serve a plain `docker build`.
#   NODE_MAJOR    the Node version of the old GitHub workflow
#   PNPM_VERSION  package.json "packageManager"
#   GO_VERSION    engine/go.mod "go" line
FROM rust:1-bookworm

ARG NODE_MAJOR=24
ARG PNPM_VERSION=12.9.1
ARG GO_VERSION=1.27.3

ENV DEBIAN_FRONTEND=noninteractive

# Tauri's Linux deps (libwebkit2gtk etc.), the smoke test's X/D-Bus/screenshot tools, and for the
# Windows cross build (Tauri v2 "Linux -> Windows"): nsis, lld, llvm (llvm-rc), clang.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git file xz-utils procps \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf \
      xvfb dbus dbus-x11 x11-apps x11-xserver-utils xauth imagemagick \
      nsis lld llvm clang \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "pnpm@${PNPM_VERSION}"

RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local

RUN rustup component add rustfmt \
    && rustup target add x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin

# the repo is mounted at /src and belongs to another uid
RUN git config --global --add safe.directory '*'

# Debian bookworm's nsis is 3.08, which lacks Include/Win/RestartManager.nsh that Tauri's installer
# template includes ("could not find Win\RestartManager.nsh"). So: the data files (stubs, plugins,
# Include) from the official Windows zip, and a makensis built from the source tarball on top of them.
# The apt nsis stays installed but /usr/local/bin comes first in PATH.
ARG NSIS_VERSION=3.11
RUN apt-get update && apt-get install -y --no-install-recommends scons zlib1g-dev unzip bzip2 \
    && cd /tmp \
    && curl -fsSL -o nsis.zip "https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip" \
    && curl -fsSL -o nsis-src.tar.bz2 "https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}-src.tar.bz2" \
    && unzip -q nsis.zip -d /opt && mv "/opt/nsis-${NSIS_VERSION}" /opt/nsis \
    && tar xjf nsis-src.tar.bz2 && cd "nsis-${NSIS_VERSION}-src" \
    && scons -j4 SKIPSTUBS=all SKIPPLUGINS=all SKIPUTILS=all SKIPMISC=all NSIS_CONFIG_CONST_DATA_PATH=no \
         PREFIX=/tmp/nsis-lin install-compiler \
    && mkdir /opt/nsis/bin && cp /tmp/nsis-lin/makensis /opt/nsis/bin/makensis && chmod +x /opt/nsis/bin/makensis \
    && ln -s /opt/nsis/bin/makensis /usr/local/bin/makensis \
    && cd / && rm -rf /tmp/nsis* && apt-get purge -y scons && rm -rf /var/lib/apt/lists/*
# makensis finds Stubs/ and Include/ at <its real dir>/../ when NSISDIR is unset (it is when Tauri
# runs it); /usr/share/nsis is where the apt package, and so Tauri, expects the data
RUN rm -rf /usr/share/nsis && ln -s /opt/nsis /usr/share/nsis
ENV NSISDIR=/opt/nsis

ENV CI=true XWIN_CACHE_DIR=/xwin-cache
WORKDIR /src
