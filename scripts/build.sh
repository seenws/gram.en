#!/usr/bin/env bash
# Build the browser bundle for index.html.
#
# index.html loads a prebuilt dist/engine.js, which embeds a *flattened snapshot*
# of the grammar taken at build time. So changes to any languages/**/*.gram or
# *.tsv file are invisible to the browser until you rebuild and hard-refresh.
#
# Two steps:
#   1. flatten  -> languages/*/*.flat.gram           (resolves %include/%import)
#   2. esbuild  -> dist/engine.js                    (bundles src/browser.ts, all langs)
#
# `npm run build` is the intended entry point, but it fails in this WSL setup (npm
# runs through Windows cmd, which rejects the \\wsl.localhost working directory),
# so this script calls the two tools directly instead.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The only Node here is Windows node.exe (no native Linux Node). Override with
# NODE=/path/to/node if you have one. node.exe needs Windows-style paths.
NODE="${NODE:-/mnt/c/Program Files/nodejs/node.exe}"
flatten_script="scripts/flatten.ts"
case "$NODE" in
    *.exe | /mnt/*) flatten_script="$(wslpath -w scripts/flatten.ts)" ;;
esac

# esbuild ships as a platform binary; the Linux ELF runs directly under WSL
# (Windows node.exe can't launch it). Fall back to the .bin shim otherwise.
esbuild="node_modules/@esbuild/linux-x64/bin/esbuild"
[ -x "$esbuild" ] || esbuild="node_modules/.bin/esbuild"

echo "==> [1/2] flatten grammars (languages/*/*.flat.gram)"
"$NODE" --experimental-strip-types "$flatten_script"

echo "==> [2/2] bundle           (dist/engine.js)"
"$esbuild" src/browser.ts --bundle \
    --format=iife --global-name=GrammarEngine --loader:.gram=text \
    --outfile=dist/engine.js

echo "==> done. Hard-refresh the browser (Ctrl/Cmd+Shift+R) to load the new bundle."
