#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
scratch_parent=${TMPDIR:-$HOME/agent-tmp}
mkdir -p "$scratch_parent"
work=$(mktemp -d "$scratch_parent/composer-tests.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
swiftc -swift-version 6 -warnings-as-errors helper/Screenshot.swift tests/HelperTests.swift -o "$work/tests"
"$work/tests"
