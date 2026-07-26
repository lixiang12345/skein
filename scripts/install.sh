#!/bin/sh
# Skein installer: guarded global npm install with version pinning.
#
# Skein ships as the npm package @skein-code/cli, so this script wraps
# `npm install -g` with prerequisite checks and post-install verification.
# Package integrity is enforced by npm's registry sha512 checks; this script
# never downloads code outside the npm toolchain.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lixiang12345/skein/main/scripts/install.sh | sh
#   sh install.sh [--version <x.y.z>] [--dry-run] [--help]
set -eu

PACKAGE='@skein-code/cli'
VERSION='latest'
DRY_RUN=0

usage() {
  cat <<'EOF'
Skein installer

Options:
  --version <x.y.z>  install an exact published version (default: latest)
  --dry-run          print the commands without installing
  --help             show this help
EOF
}

fail() {
  printf 'skein-install: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a value'
      VERSION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (see --help)"
      ;;
  esac
done

case "$VERSION" in
  latest) ;;
  [0-9]*.[0-9]*.[0-9]*)
    case "$VERSION" in
      *[!0-9.]*) fail "--version must be an exact x.y.z version, got: $VERSION" ;;
    esac
    ;;
  *) fail "--version must be an exact x.y.z version, got: $VERSION" ;;
esac

command -v node >/dev/null 2>&1 || fail 'Node.js is required (>= 22.16). Install it from https://nodejs.org/'
command -v npm >/dev/null 2>&1 || fail 'npm is required. It ships with Node.js >= 22.16.'

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)' \
  || fail "Node.js $(node --version) is too old; Skein requires >= 22.16."

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'plan: npm install -g %s@%s\n' "$PACKAGE" "$VERSION"
  printf 'plan: skein --version\n'
  exit 0
fi

printf 'Installing %s@%s ...\n' "$PACKAGE" "$VERSION"
npm install -g "$PACKAGE@$VERSION"

if command -v skein >/dev/null 2>&1; then
  printf 'Installed skein %s\n' "$(skein --version)"
  printf 'Run `skein` inside a project to start; `skein doctor` checks prerequisites.\n'
else
  printf 'skein was installed but is not on PATH.\n' >&2
  printf 'Add the npm global bin directory to PATH: %s\n' "$(npm prefix -g)/bin" >&2
  exit 1
fi
