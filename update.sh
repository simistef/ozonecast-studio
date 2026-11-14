#!/usr/bin/env bash
# OzoneCast Studio - Synology DSM Auto-Updater Script
# Can be run manually on your NAS or scheduled via Synology DSM Task Scheduler
# (DSM -> Control Panel -> Task Scheduler -> User-defined script -> run as root)
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR" || exit 1

FORCE_REBUILD=0
if [ "$1" = "--force" ] || [ "$1" = "-f" ] || [ "$1" = "force" ] || [ "$1" = "rebuild" ]; then
  FORCE_REBUILD=1
fi

# Determine docker compose command (including Synology DSM 7 ContainerManager path)
DOCKER_COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker-compose"
elif [ -x "/var/packages/ContainerManager/target/usr/bin/docker" ]; then
  DOCKER_COMPOSE_CMD="/var/packages/ContainerManager/target/usr/bin/docker compose"
elif [ -x "/usr/local/bin/docker-compose" ]; then
  DOCKER_COMPOSE_CMD="/usr/local/bin/docker-compose"
else
  DOCKER_COMPOSE_CMD="docker compose"
fi

# Check if inside a git repository
if [ -d ".git" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Checking for updates on GitHub..."
  git fetch origin main

  LOCAL_COMMIT="$(git rev-parse HEAD)"
  REMOTE_COMMIT="$(git rev-parse origin/main)"

  if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ] && [ "$FORCE_REBUILD" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] OzoneCast Studio is already up to date ($LOCAL_COMMIT)."
    echo "To force rebuild & restart container anyway, run: ./update.sh --force"
    exit 0
  fi

  if [ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] New version detected ($REMOTE_COMMIT). Updating from $LOCAL_COMMIT..."
    git reset --hard origin/main
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Force rebuild requested on commit ($LOCAL_COMMIT)..."
  fi
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rebuilding Docker container in $PROJECT_DIR..."
fi

# Rebuild container and recreate daemon
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Building Docker image (no cache)..."
$DOCKER_COMPOSE_CMD build --no-cache
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Recreating and starting OzoneCast container..."
$DOCKER_COMPOSE_CMD up -d --force-recreate

echo "[$(date '+%Y-%m-%d %H:%M:%S')] OzoneCast Studio updated and running successfully!"
