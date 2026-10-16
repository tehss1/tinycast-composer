#!/bin/sh
# Rebuilds assets/composer-helper as a universal, ad-hoc signed binary. Needs a Mac with Swift 6.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
  swiftc -swift-version 6 -O -target "$arch-apple-macos26.0" helper/main.swift -o "$work/$arch"
done
lipo -create "$work/arm64" "$work/x86_64" -output assets/composer-helper
codesign -s - -f -i tech.uncomplicate.tinycast-composer.helper assets/composer-helper
chmod 755 assets/composer-helper
lipo -info assets/composer-helper
