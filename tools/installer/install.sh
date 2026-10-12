#!/bin/sh
# Installs the Confidential Router gatekeeper from GitHub Releases.
#
#   curl -fsSL https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.sh | sh
#
# POSIX sh on purpose: this has to run under Alpine's busybox ash and under
# macOS's ancient bash alike, so there are no arrays, no `local`, and no
# bashisms below. The binaries it installs are static (CGO_ENABLED=0), so one
# Linux archive covers glibc and musl both.
#
# Options (flags, or the matching environment variable):
#
#   --version <v>       GATEKEEPER_VERSION       0.1.0 | v0.1.0 | gatekeeper-v0.1.0 | nightly
#   --install-dir <d>   GATEKEEPER_INSTALL_DIR   default: /usr/local/bin if writable, else ~/.local/bin
#   --repo <o/r>        GATEKEEPER_REPO          default: Super-Protocol/confidential-router
#   --base-url <url>    GATEKEEPER_BASE_URL      release download root; https:// or file:// (a mirror, or an
#                                                offline copy of the release directory)
#   --api-url <url>     GATEKEEPER_API_URL       default: https://api.github.com
#   --no-modify-path    GATEKEEPER_NO_MODIFY_PATH  do not touch any shell startup file
#   --help
#
# GITHUB_TOKEN, if set, authenticates the one API call that resolves "latest",
# which is what the anonymous 60-requests-per-hour limit applies to.
#
# Exit codes: 0 installed, 1 failed, 2 bad usage, 3 unsupported platform.

set -eu

GATEKEEPER_REPO="${GATEKEEPER_REPO:-Super-Protocol/confidential-router}"
GATEKEEPER_API_URL="${GATEKEEPER_API_URL:-https://api.github.com}"
GATEKEEPER_VERSION="${GATEKEEPER_VERSION:-}"
GATEKEEPER_INSTALL_DIR="${GATEKEEPER_INSTALL_DIR:-}"
GATEKEEPER_BASE_URL="${GATEKEEPER_BASE_URL:-}"
GATEKEEPER_NO_MODIFY_PATH="${GATEKEEPER_NO_MODIFY_PATH:-}"

# Releases are tagged `gatekeeper-v<semver>`: this is a monorepo and the router
# will get tags of its own.
TAG_PREFIX='gatekeeper-'

tmpdir=''

log() { printf '%s\n' "$*" >&2; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit "${2:-1}"; }

cleanup() {
  [ -n "$tmpdir" ] && [ -d "$tmpdir" ] && rm -rf "$tmpdir"
  return 0
}

usage() {
  cat <<'EOF'
Installs the Confidential Router gatekeeper from GitHub Releases.

  curl -fsSL https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.sh | sh

Options (flag, or the matching environment variable):

  --version <v>       GATEKEEPER_VERSION       0.1.0 | v0.1.0 | gatekeeper-v0.1.0 | nightly
  --install-dir <d>   GATEKEEPER_INSTALL_DIR   default: /usr/local/bin if writable, else ~/.local/bin
  --repo <owner/repo> GATEKEEPER_REPO          default: Super-Protocol/confidential-router
  --base-url <url>    GATEKEEPER_BASE_URL      release download root; https:// or file://
  --api-url <url>     GATEKEEPER_API_URL       default: https://api.github.com
  --no-modify-path    GATEKEEPER_NO_MODIFY_PATH  do not touch any shell startup file
  -h, --help

GITHUB_TOKEN, if set, authenticates the one API call that resolves "latest".
EOF
}

# --- platform -----------------------------------------------------------------

# detect_os prints the GOOS token GoReleaser put in the archive name.
detect_os() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die 'Windows is installed with install.ps1:
  irm https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.ps1 | iex' 3
      ;;
    *) die "unsupported operating system: $(uname -s)" 3 ;;
  esac
}

# detect_arch prints the GOARCH token, folding the spellings uname reports.
detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) die "unsupported CPU architecture: $(uname -m) (linux/macOS amd64 and arm64 are published)" 3 ;;
  esac
}

# archive_name is the GoReleaser `name_template` from apps/gatekeeper/.goreleaser.yaml.
# Changing one without the other breaks every install.
archive_name() {
  case "$1" in
    windows) printf 'gatekeeper_%s_%s_%s.zip' "$2" "$1" "$3" ;;
    *) printf 'gatekeeper_%s_%s_%s.tar.gz' "$2" "$1" "$3" ;;
  esac
}

# --- version ------------------------------------------------------------------

# release_tag turns whatever the user typed into the git tag of the release.
# `0.1.0`, `v0.1.0` and `gatekeeper-v0.1.0` are the same release; `nightly` is
# the rolling pre-release, and carries no `v`.
release_tag() {
  ref="${1#"$TAG_PREFIX"}"
  case "$ref" in
    [0-9]*) ref="v$ref" ;;
  esac
  printf '%s%s' "$TAG_PREFIX" "$ref"
}

# version_token is what the archive name carries: the tag with its prefixes
# removed, so `gatekeeper-v0.1.0` -> `0.1.0` and `gatekeeper-nightly` -> `nightly`.
version_token() {
  ref="${1#"$TAG_PREFIX"}"
  case "$ref" in
    v[0-9]*) printf '%s' "${ref#v}" ;;
    *) printf '%s' "$ref" ;;
  esac
}

# resolve_latest_tag asks GitHub which release is current. `releases/latest`
# never points at a pre-release, so the nightly cannot be installed by accident.
resolve_latest_tag() {
  url="${GATEKEEPER_API_URL%/}/repos/${GATEKEEPER_REPO}/releases/latest"
  body="$(http_get_stdout "$url")" ||
    die "could not reach $url — pass --version to install a specific release"
  tag="$(printf '%s' "$body" | tr ',' '\n' |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || die "no release found at $url — pass --version to install a specific release"
  printf '%s' "$tag"
}

# --- download and verify ------------------------------------------------------

http_get_stdout() {
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$1"
    else
      curl -fsSL "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      wget -qO- --header="Authorization: Bearer ${GITHUB_TOKEN}" "$1"
    else
      wget -qO- "$1"
    fi
  else
    die 'neither curl nor wget is installed'
  fi
}

http_get_file() {
  # A file: base URL is how a mirror, an air-gapped copy, or the release
  # workflow's smoke test hands over artifacts it already has; busybox wget
  # cannot fetch one, so the copy is done here rather than by the downloader.
  case "$1" in
    file://*)
      src="${1#file://}"
      [ -f "$src" ] || return 1
      cp "$src" "$2"
      return 0
      ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die 'neither curl nor wget is installed'
  fi
}

# sha256_of prints the lower-case hex digest of a file, using whichever of the
# three tools this system has: coreutils and busybox have sha256sum, macOS has
# shasum, and openssl is the fallback on hosts with neither.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else
    die 'no SHA-256 tool found (sha256sum, shasum or openssl)'
  fi
}

# expected_sha reads one entry out of GoReleaser's `checksums.txt`, whose lines
# are `<hex>  <filename>`. awk rather than sed, because the file name is data:
# as a sed pattern its dots would match any character.
expected_sha() {
  awk -v want="$2" '{ sub(/^\*/, "", $2); if ($2 == want) { print $1; exit } }' "$1"
}

lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# verify_checksum fails loudly rather than installing an archive it cannot
# account for: a missing entry is as disqualifying as a wrong one.
verify_checksum() {
  archive="$1"
  checksums="$2"
  name="$3"

  want="$(expected_sha "$checksums" "$name")"
  [ -n "$want" ] || die "$name is not listed in checksums.txt"

  got="$(sha256_of "$archive")"
  if [ "$(lower "$want")" != "$(lower "$got")" ]; then
    die "checksum mismatch for $name
  expected $want
  actual   $got"
  fi
}

# --- install destination ------------------------------------------------------

on_path() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# writable_dir is true for a directory that takes a write, whether it exists
# already or has to be created: `mkdir -p` is coming either way, and a candidate
# is only worth preferring if that will succeed.
writable_dir() {
  if [ -d "$1" ]; then
    [ -w "$1" ]
  else
    parent="$(dirname "$1")"
    [ -d "$parent" ] && [ -w "$parent" ]
  fi
}

# default_install_dir prefers a writable directory the shell *already searches*,
# and only then the per-user one.
#
# Preferring the PATH is the whole of SUP-295 item 1. On macOS /usr/local/bin is
# root-owned on a machine without Homebrew, so the install fell through to
# ~/.local/bin — which zsh's default PATH does not contain. `curl | sh` then
# reported success and `gatekeeper init`, the very next line of the console's
# copy-paste block, was command-not-found.
#
# Nothing here escalates: an install that silently asked for sudo would be a
# worse surprise than one that lands in ~/.local/bin and says so.
default_install_dir() {
  for candidate in /usr/local/bin "${HOME:-/tmp}/.local/bin" "${HOME:-/tmp}/bin"; do
    if on_path "$candidate" && writable_dir "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  printf '%s/.local/bin' "${HOME:-/tmp}"
}

# --- PATH ---------------------------------------------------------------------

# The line that marks our own addition, so a second install can recognise it and
# a reader knows who wrote it.
PATH_MARKER='# added by the Confidential Router gatekeeper installer'

# rc_file_for names the startup file the given login shell reads, or nothing
# when this script has no business guessing.
#
# bash reads a different file per platform and the difference is not cosmetic:
# macOS Terminal opens a *login* shell, which reads .bash_profile and never
# .bashrc; a Linux terminal opens an interactive non-login one, which reads
# .bashrc and never .bash_profile. Writing to the other one is writing to
# nowhere.
rc_file_for() {
  case "${1##*/}" in
    zsh) printf '%s/.zshrc' "${HOME:-}" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then
        printf '%s/.bash_profile' "${HOME:-}"
      else
        printf '%s/.bashrc' "${HOME:-}"
      fi
      ;;
    *) printf '' ;;
  esac
}

# rc_has_dir is true when the startup file already puts this directory on the
# PATH — ours or the reader's own line, because a second copy of either is
# noise rather than a fix.
rc_has_dir() {
  # Two fixed-string passes rather than one pattern: an install directory is a
  # path, and its dots would match any character as a regex.
  [ -f "$1" ] && grep -F "$2" "$1" 2>/dev/null | grep -q 'PATH'
}

# report_path closes the install the way rustup does: say where the binary went,
# make it permanent for the next terminal, and hand over the one line that makes
# it work in *this* one. A shell cannot export into its parent, so no installer
# run through a pipe can skip that last part.
report_path() {
  dir="$1"
  if on_path "$dir"; then
    return 0
  fi

  rc=''
  if [ -z "$GATEKEEPER_NO_MODIFY_PATH" ]; then
    rc="$(rc_file_for "${SHELL:-}")"
  fi

  log ""
  log "$dir is not on your PATH."
  if [ -n "$rc" ] && rc_has_dir "$rc" "$dir"; then
    log "$rc already adds it, so new terminals will find gatekeeper."
  elif [ -n "$rc" ]; then
    # `$PATH` stays literal: the startup file has to expand it at shell start,
    # not now.
    printf '\n%s\n%s\n' "$PATH_MARKER" "export PATH=\"$dir:\$PATH\"" >> "$rc" &&
      log "Added it to $rc, so new terminals will find gatekeeper." ||
      log "Could not write to $rc; add the line below to it yourself."
  else
    log "Add the line below to your shell's startup file to make that permanent."
  fi
  log ""
  log "To use gatekeeper in this terminal, run:"
  log "  export PATH=\"$dir:\$PATH\""
}

# --- main ---------------------------------------------------------------------

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) [ "$#" -ge 2 ] || die 'missing value for --version' 2; GATEKEEPER_VERSION="$2"; shift 2 ;;
      --version=*) GATEKEEPER_VERSION="${1#*=}"; shift ;;
      --install-dir) [ "$#" -ge 2 ] || die 'missing value for --install-dir' 2; GATEKEEPER_INSTALL_DIR="$2"; shift 2 ;;
      --install-dir=*) GATEKEEPER_INSTALL_DIR="${1#*=}"; shift ;;
      --repo) [ "$#" -ge 2 ] || die 'missing value for --repo' 2; GATEKEEPER_REPO="$2"; shift 2 ;;
      --repo=*) GATEKEEPER_REPO="${1#*=}"; shift ;;
      --base-url) [ "$#" -ge 2 ] || die 'missing value for --base-url' 2; GATEKEEPER_BASE_URL="$2"; shift 2 ;;
      --base-url=*) GATEKEEPER_BASE_URL="${1#*=}"; shift ;;
      --api-url) [ "$#" -ge 2 ] || die 'missing value for --api-url' 2; GATEKEEPER_API_URL="$2"; shift 2 ;;
      --api-url=*) GATEKEEPER_API_URL="${1#*=}"; shift ;;
      --no-modify-path) GATEKEEPER_NO_MODIFY_PATH=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (try --help)" 2 ;;
    esac
  done
}

main() {
  parse_args "$@"

  os="$(detect_os)"
  arch="$(detect_arch)"

  if [ -n "$GATEKEEPER_VERSION" ]; then
    tag="$(release_tag "$GATEKEEPER_VERSION")"
  else
    tag="$(resolve_latest_tag)"
  fi
  version="$(version_token "$tag")"

  base="${GATEKEEPER_BASE_URL:-https://github.com/${GATEKEEPER_REPO}/releases/download}"
  name="$(archive_name "$os" "$version" "$arch")"

  trap cleanup EXIT INT TERM
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/gatekeeper-install.XXXXXX")"

  log "Installing gatekeeper $version ($os/$arch) from $tag"

  http_get_file "${base%/}/${tag}/${name}" "$tmpdir/$name" ||
    die "download failed: ${base%/}/${tag}/${name}"
  http_get_file "${base%/}/${tag}/checksums.txt" "$tmpdir/checksums.txt" ||
    die "download failed: ${base%/}/${tag}/checksums.txt"

  verify_checksum "$tmpdir/$name" "$tmpdir/checksums.txt" "$name"
  log "Checksum OK"

  tar -xzf "$tmpdir/$name" -C "$tmpdir" || die "could not unpack $name"
  [ -f "$tmpdir/gatekeeper" ] || die "$name does not contain a gatekeeper binary"

  dir="${GATEKEEPER_INSTALL_DIR:-$(default_install_dir)}"
  mkdir -p "$dir" || die "could not create $dir"
  [ -w "$dir" ] || die "$dir is not writable — re-run with --install-dir <dir>, or as root"

  chmod 0755 "$tmpdir/gatekeeper"
  # Copied beside the target and then renamed over it, rather than copied onto
  # it: the rename is atomic, so an interrupted install never leaves a truncated
  # gatekeeper on the PATH, and replacing a running binary this way works where
  # writing through it would fail.
  staged="$dir/.gatekeeper.$$"
  cp "$tmpdir/gatekeeper" "$staged" || die "could not write to $dir"
  if ! mv -f "$staged" "$dir/gatekeeper"; then
    rm -f "$staged"
    die "could not install into $dir"
  fi

  log "Installed $dir/gatekeeper"
  "$dir/gatekeeper" version || die 'the installed binary did not run'

  report_path "$dir"
}

# Sourced by install.test.sh (next to this file), which calls the functions above
# one at a time; anything else runs the installer.
if [ -z "${GATEKEEPER_INSTALL_SOURCE_ONLY:-}" ]; then
  main "$@"
fi
