#!/usr/bin/env sh
# Pull the latest images and restart changed containers. Run on the server
# from the repo root: ./infra/deploy.sh
set -eu
cd "$(dirname "$0")/.."

git pull --ff-only
compose="docker compose -f infra/docker-compose.prod.yml --env-file .env"
$compose pull
$compose up -d --remove-orphans
docker image prune -f
$compose ps
