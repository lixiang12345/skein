#!/bin/sh
set -eu

if ! command -v expect >/dev/null 2>&1; then
  echo "test:pty requires expect" >&2
  exit 1
fi

artifacts="${SKEIN_PTY_ARTIFACTS:-.skein/pty-artifacts}"
workspace=$(mktemp -d "${TMPDIR:-/tmp}/skein-pty.XXXXXX")
trap 'rm -rf "$workspace"' EXIT HUP INT TERM

mkdir -p "$artifacts" "$workspace/src/ui" "$workspace/.agents/skills/pty-audit"
printf '%s\n' 'export const ptyFixture = true;' > "$workspace/src/ui/tui.tsx"
printf '%s\n' \
  '---' \
  'name: pty-audit' \
  'description: Inspect terminal release surfaces.' \
  '---' \
  '# PTY audit' \
  'Review terminal output without side effects.' \
  > "$workspace/.agents/skills/pty-audit/SKILL.md"

for width in 20 24 40 80 120; do
  mode=unicode
  if [ "$width" = 24 ]; then mode=ascii; fi
  output="$artifacts/${width}-${mode}.log"
  expect test/pty/interactive.exp "$width" "$mode" "$output" "$workspace"
  node test/pty/check-output.mjs "$output" "$width" "$mode"
done

for entry in "40 dumb" "80 screen-reader"; do
  set -- $entry
  width=$1
  mode=$2
  output="$artifacts/${width}-${mode}.log"
  expect test/pty/interactive.exp "$width" "$mode" "$output" "$workspace"
  node test/pty/check-output.mjs "$output" "$width" "$mode"
done

short_output="$artifacts/40x10-unicode.log"
expect test/pty/short-height.exp "$short_output" "$workspace"
node test/pty/check-output.mjs "$short_output" 40 unicode short
