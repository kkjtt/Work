#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
go mod tidy
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o nft_market .
7z a -t7z nft_market.7z nft_market
echo "Created $(pwd)/nft_market.7z"
