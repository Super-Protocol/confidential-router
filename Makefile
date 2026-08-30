# Thin convenience wrapper over the pnpm/Nx targets. Everything here has a
# `pnpm` equivalent; the Makefile exists for people who reach for `make` first.
.DEFAULT_GOAL := help
.PHONY: help install verify lint lint-fix typecheck build test format gatekeeper dev-up dev-down clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

verify: ## lint + typecheck + build + test across the workspace
	pnpm nx run-many -t lint typecheck build test

lint: ## Lint every project
	pnpm nx run-many -t lint

lint-fix: ## Autofix lint and formatting issues
	pnpm nx run-many -t lint-fix

typecheck: ## Typecheck every TypeScript project
	pnpm nx run-many -t typecheck

build: ## Build every project
	pnpm nx run-many -t build

test: ## Run every unit test suite
	pnpm nx run-many -t test

format: ## Format with Biome
	pnpm exec biome format --write .

gatekeeper: ## Build the Go gatekeeper binary
	pnpm nx run gatekeeper:build

dev-up: ## Start local dev services (PostgreSQL)
	docker compose -f docker/docker-compose.dev.yml up -d

dev-down: ## Stop local dev services
	docker compose -f docker/docker-compose.dev.yml down

clean: ## Reset the Nx cache and daemon
	pnpm nx reset
