# Build image of the Linux and Windows legs of scripts/ci-local.sh (always built with --platform linux/amd64, so an
# Apple Silicon Mac runs it under Rosetta in OrbStack/Docker Desktop). The macOS legs run on the
# host. Built by ci-local.sh with the versions below taken from the repo; the defaults only
# serve a plain `docker build`.
#   NODE_MAJOR    the Node version of the old GitHub workflow
#   PNPM_VERSION  package.json "packageManager"
#   GO_VERSION    the repository's go.mod "go" line
FROM debian:bookworm

ARG NODE_MAJOR=24
ARG PNPM_VERSION=12.9.1
ARG GO_VERSION=1.27.3

ENV DEBIAN_FRONTEND=noninteractive

# What Electron needs to run (the smoke test) and electron-builder to package: the GTK/NSS/X
# libraries, the smoke test's X/D-Bus tools, fakeroot and dpkg for the .deb, and wine for the
# Windows cross build (rcedit sets the exe's icon and version; makensis comes with electron-builder).
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git file xz-utils procps \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libsecret-1-0 \
      xvfb dbus dbus-x11 x11-apps x11-xserver-utils xauth \
      fakeroot dpkg-dev rpm \
      wine wine64 wine32 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "pnpm@${PNPM_VERSION}"

RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local

# the repo is mounted at /src and belongs to another uid
RUN git config --global --add safe.directory '*'

ENV CI=true WINEDEBUG=-all
WORKDIR /src
