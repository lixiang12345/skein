#!/bin/sh
set -eu

if ! command -v expect >/dev/null 2>&1; then
  echo "test:pty requires expect" >&2
  exit 1
fi

artifacts=".mosaic/pty-artifacts"
workspace=$(mktemp -d "${TMPDIR:-/tmp}/skein-pty.XXXXXX")
trap 'rm -rf "$workspace"' EXIT HUP INT TERM

mkdir -p "$artifacts" "$workspace/src/ui"
printf '%s\n' 'export const ptyFixture = true;' > "$workspace/src/ui/tui.tsx"

for width in 20 24 40 80 120; do
  mode=unicode
  if [ "$width" = 24 ]; then mode=ascii; fi
  output="$artifacts/${width}-${mode}.log"
  expect test/pty/interactive.exp "$width" "$mode" "$output" "$workspace"
  node test/pty/check-output.mjs "$output" "$width" "$mode"
done

short_output="$artifacts/40x10-unicode.log"
expect test/pty/short-height.exp "$short_output" "$workspace"
node test/pty/check-output.mjs "$short_output" 40 unicode short
