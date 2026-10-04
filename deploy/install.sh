#!/usr/bin/env sh
set -eu

# Run from an already reviewed checkout. This installs only the control plane.
# Host enrollment is a separate, explicitly scoped operation.
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker Engine is required. Install it for your distribution first.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { printf '%s\n' 'Docker Compose v2 is required.' >&2; exit 1; }
docker compose up --help | grep -q -- '--wait-timeout' || { printf '%s\n' 'A current Docker Compose v2 with --wait support is required.' >&2; exit 1; }
test -f "$project_dir/pnpm-lock.yaml" || { printf '%s\n' 'Missing lockfile: use a complete checkout.' >&2; exit 1; }
printf '%s\n' 'Building and starting the Qiyun control plane. Existing application services are not modified.'
cd "$project_dir"
# Compose resolves build.context relative to deploy/compose.yaml. Overriding its
# project directory to the repository root would resolve ".." outside the checkout.
docker compose -f deploy/compose.yaml up -d --build --wait --wait-timeout 120
printf '%s\n' 'Initialize your administrator interactively:'
printf '%s\n' 'docker compose -f deploy/compose.yaml exec control node apps/control/dist/bootstrap.js'
web_address=$(docker compose -f deploy/compose.yaml port control 4310)
printf '%s\n' "Open http://$web_address (or use SSH local forwarding on a remote server)."
printf '%s\n' 'Agent enrollment, CA trust, and helper allowlists: see docs/RUNNING.md.'
