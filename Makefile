# Thin convenience wrapper over the pnpm/Nx targets. Everything here has a
# `pnpm` equivalent; the Makefile exists for people who reach for `make` first.
.DEFAULT_GOAL := help
.PHONY: help install verify lint lint-fix typecheck build test e2e e2e-image demo format gatekeeper dev-up dev-down images up up-core down clean

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

e2e: ## Run every e2e suite (API as a process, the console, the demo)
	pnpm nx run-many -t e2e

e2e-image: ## Run the console image against two API origins (needs `make images`)
	pnpm nx run @confidential-router/router-ui-e2e:e2e-image

demo: ## The end-to-end story: gatekeeper -> router -> model, with a live rotation
	pnpm nx run gatekeeper:e2e

format: ## Format with Biome
	pnpm exec biome format --write .

gatekeeper: ## Build the Go gatekeeper binary
	pnpm nx run gatekeeper:build

dev-up: ## Start local dev services (PostgreSQL)
	docker compose -f docker/docker-compose.dev.yml up -d

dev-down: ## Stop local dev services
	docker compose -f docker/docker-compose.dev.yml down

images: ## Build the router-api and router-ui images, tagged :local
	docker build -f router-api.dockerfile -t confidential-router/router-api:local .
	docker build -f router-ui.dockerfile -t confidential-router/router-ui:local .

up: ## Bring up the full demo stack (console, API, PostgreSQL, mock model + evidence)
	docker compose -f docker/docker-compose.yml --profile demo up -d --build --wait

up-core: ## Same without the demo stand-ins: no model backend, no evidence
	docker compose -f docker/docker-compose.yml up -d --build --wait

down: ## Stop the demo stack and drop its volumes
	docker compose -f docker/docker-compose.yml --profile demo down -v

clean: ## Reset the Nx cache and daemon
	pnpm nx reset
