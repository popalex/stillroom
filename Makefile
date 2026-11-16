# Stillroom commands: the pnpm scripts and Docker Compose steps from the README.
# Run `make` or `make help` to list them. Compose reads the repo-root .env that
# `make setup-tailscale` writes, since compose.yaml sits next to it.

.DEFAULT_GOAL := help
.PHONY: help install dev build typecheck format format-check test e2e check \
	up down restart logs ps status setup-tailscale backup clean

help: ## List the targets
	@grep -hE '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | \
		awk -F ':.*## ' '{ printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }'

# Development

install: ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

dev: ## Run the server and Vite with reload, on http://localhost:5173
	pnpm dev

build: ## Typecheck and build the website and server
	pnpm build

typecheck: ## Typecheck the website without building
	pnpm typecheck

format: ## Rewrite files with Prettier
	pnpm format

format-check: ## Fail if any file needs Prettier
	pnpm format:check

test: ## Run the unit tests
	pnpm test

# The browser test serves dist/, so it builds first. Playwright upgrades need a
# matching Chromium, and the install is a no-op when it is already there.
e2e: build ## Build, then run the Playwright browser test
	pnpm exec playwright install chromium
	pnpm test:e2e

# CI's test job also loads better-sqlite3's binary and builds the Docker image in
# a second job. `make up` covers the image.
check: format-check e2e test ## Run the checks from CI's test job

# Deployment (Docker Compose with Tailscale)

up: ## Build the image and start the gallery and Tailscale
	docker compose up -d --build

# Keeps the tailscale-state volume, so the container stays authorized on the
# tailnet. `docker compose down -v` would delete it and need a new login.
down: ## Stop and remove the containers
	docker compose down

restart: ## Restart the containers without rebuilding
	docker compose restart

logs: ## Follow the last 50 lines of both containers' logs
	docker compose logs -f --tail=50 tailscale viewer

ps: ## Show container status
	docker compose ps

status: ## Show Tailscale and Tailscale Serve status
	docker compose exec tailscale tailscale status
	docker compose exec tailscale tailscale serve status

setup-tailscale: ## Write .env with the Tailscale container's hostname
	pnpm setup:tailscale

# DIR must be a new directory, ideally on encrypted storage. See the README.
backup: ## Snapshot the vault: make backup DIR=/path/to/new-backup-directory
	@test -n "$(DIR)" || { echo 'Usage: make backup DIR=/path/to/new-backup-directory'; exit 2; }
	pnpm backup "$(DIR)"

clean: ## Delete build output and test results
	rm -rf dist dist-server test-results playwright-report
