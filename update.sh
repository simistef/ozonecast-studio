#!/usr/bin/env bash
# OzoneCast Studio - Synology DSM Auto-Updater Script
# Can be run manually on your NAS or scheduled via Synology DSM Task Scheduler
# (DSM -> Control Panel -> Task Scheduler -> User-defined script -> run as root)

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR" || exit 1

# Check if inside a git repository
if [ ! -d ".git" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Error: .git directory not found in $PROJECT_DIR" >&2
  exit 1
fi

# Fetch latest commits from GitHub
git fetch origin main

LOCAL_COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(git rev-parse origin/main)"

if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] OzoneCast Studio is already up to date ($LOCAL_COMMIT)."
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] New version detected ($REMOTE_COMMIT). Updating from $LOCAL_COMMIT..."

# Reset local tree to origin/main
git reset --hard origin/main

# Rebuild container and recreate daemon
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose build --no-cache
  docker-compose up -d --force-recreate
else
  docker compose build --no-cache
  docker compose up -d --force-recreate
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] OzoneCast Studio updated successfully to $REMOTE_COMMIT."
