#!/bin/bash
set -e

DIST_REPO="/Users/heeyunkim/study-chat-dist"

echo "==> Building frontend..."
cd "$(dirname "$0")/client"
npm install --silent
npm run build

echo "==> Copying dist to study-chat-dist..."
rsync -av --delete --exclude='.git' dist/ "$DIST_REPO/"

echo "==> Pushing to study-chat-dist..."
cd "$DIST_REPO"
git add -A
git commit -m "deploy $(date +%Y-%m-%d_%H-%M-%S)" || echo "Nothing to commit."
git push

echo "==> Done!"
