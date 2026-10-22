GO ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS = -s -w -X main.version=$(VERSION) -X github.com/davidbudac/modern-tkprof/internal/report.Version=$(VERSION)

.PHONY: build test web lint release clean

build: ## build the binary for this machine into bin/
	$(GO) build -ldflags "$(LDFLAGS)" -o bin/mtkprof ./cmd/mtkprof

test:
	$(GO) test ./...

web: ## build the web UI and embed it (needs node + pnpm)
	cd web && pnpm install --silent && pnpm build
	cp web/dist/index.html internal/ui/dist/index.html

release: ## cross-compile every supported target into dist/
	@mkdir -p dist
	@for t in linux/amd64 linux/arm64 windows/amd64 aix/ppc64 solaris/amd64 darwin/arm64 darwin/amd64; do \
		os=$${t%/*}; arch=$${t#*/}; ext=""; [ $$os = windows ] && ext=.exe; \
		echo "  $$t"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build -ldflags "$(LDFLAGS)" -o dist/mtkprof-$$os-$$arch$$ext ./cmd/mtkprof || exit 1; \
	done
	@cd dist && sha256sum mtkprof-* > SHA256SUMS

clean:
	rm -rf bin dist web/dist
