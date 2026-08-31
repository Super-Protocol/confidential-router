#!/bin/sh
# Runs install.test.sh inside the Linux distributions the gatekeeper claims to
# support, so "one static binary covers glibc and musl" is a result rather than
# a hope.
#
#   sh tools/installer/install.docker.sh          # or: pnpm nx run installer:test-distros
#   DISTROS='alpine:3.21' sh tools/installer/install.docker.sh
#
# Not part of the PR checks: it needs a Docker daemon and pulls three images.
# The equivalent proof against a real release — on Ubuntu, Alpine, Fedora, macOS
# arm64 and Windows — is the `verify-install` matrix in
# .github/workflows/release-gatekeeper.yml, which runs on every tag.

set -eu

here="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"

# Alpine is the musl case and runs the suite under busybox ash rather than bash;
# Fedora is the second glibc distribution, with a different curl and coreutils.
DISTROS="${DISTROS:-ubuntu:24.04 alpine:3.22 fedora:42}"

setup_for() {
  case "$1" in
    ubuntu*|debian*) echo 'apt-get update -qq && apt-get install -y -qq curl python3 ca-certificates >/dev/null' ;;
    alpine*) echo 'apk add --no-cache curl python3 tar >/dev/null' ;;
    fedora*) echo 'dnf install -y -q curl python3 tar >/dev/null' ;;
    *) echo 'true' ;;
  esac
}

command -v docker >/dev/null 2>&1 || { echo 'install.docker.sh needs docker' >&2; exit 1; }

failures=0
for image in $DISTROS; do
  echo ''
  echo "=== $image ==="
  if docker run --rm -v "$here:/installer:ro" -w /installer "$image" \
    sh -c "$(setup_for "$image") && sh /installer/install.test.sh"; then
    echo "=== $image: passed ==="
  else
    echo "=== $image: FAILED ==="
    failures=$((failures + 1))
  fi
done

echo ''
if [ "$failures" -eq 0 ]; then
  echo 'install.sh: every distribution passed'
else
  echo "install.sh: $failures distribution(s) failed"
  exit 1
fi
