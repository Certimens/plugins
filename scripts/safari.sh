#!/usr/bin/env bash
# Converts dist/safari/ (produced by `npm run build`) into an Xcode project (macOS + iOS app
# embedding the extension), then builds the macOS app unsigned to verify the project.
# macOS only (Xcode). Signing and App Store submission are done from Xcode (see README).
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d dist/safari ] || { echo "dist/safari absent : lancer npm run build d'abord." >&2; exit 1; }

rm -rf dist/safari-xcode
xcrun safari-web-extension-converter dist/safari \
    --project-location dist/safari-xcode \
    --app-name Certimens \
    --bundle-identifier fr.certimens.agent \
    --copy-resources --no-open --no-prompt --force

project=$(find dist/safari-xcode -maxdepth 2 -name '*.xcodeproj' | head -n 1)
xcodebuild -project "$project" -scheme 'Certimens (macOS)' -configuration Release \
    CODE_SIGNING_ALLOWED=NO build
echo "Projet Xcode : $project"
