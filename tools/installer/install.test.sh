#!/bin/sh
# Tests for install.sh, against a fake release served over HTTP.
#
#   sh tools/installer/install.test.sh          # or: pnpm nx run installer:test
#
# POSIX sh, like the script it tests, so the same file can be run under Alpine's
# busybox ash to prove the installer works on musl (see install.docker.sh).
#
# The fake release is a real tar.gz with a real checksums.txt in GoReleaser's
# format, served by python3's http.server on a loopback port; the "binary" it
# carries is a two-line shell script, because what is under test is the
# download-verify-install path and not the gatekeeper itself.

set -eu

here="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
install_sh="$here/install.sh"

REPO='acme/demo'
TAG='gatekeeper-v9.9.9'
VERSION='9.9.9'

failures=0
server_pid=''
workdir=''

cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  [ -n "$workdir" ] && [ -d "$workdir" ] && rm -rf "$workdir"
  return 0
}
trap cleanup EXIT INT TERM

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failures=$((failures + 1)); }

expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$3], got [$2]"; fi
}

expect_contains() {
  case "$2" in
    *"$3"*) pass "$1" ;;
    *) fail "$1" "expected output to contain [$3], got [$2]" ;;
  esac
}

# --- fixtures -----------------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# build_release lays out what GitHub would serve: the release's assets under
# /<tag>/, and the API's `releases/latest` document at the path install.sh asks
# for. `latest` is a plain file — http.server does not care that it has no
# extension, and neither does the script.
build_release() {
  root="$1"
  os="$2"
  arch="$3"

  mkdir -p "$root/$TAG" "$root/repos/$REPO/releases" "$root/staging"
  cat > "$root/staging/gatekeeper" <<'EOF'
#!/bin/sh
[ "${1:-}" = version ] && echo "gatekeeper 9.9.9 (commit deadbeef, built 2026-01-01T00:00:00Z, test, test)"
EOF
  chmod 0755 "$root/staging/gatekeeper"

  name="gatekeeper_${VERSION}_${os}_${arch}.tar.gz"
  (cd "$root/staging" && tar -czf "$root/$TAG/$name" gatekeeper)

  # The Windows asset is a real zip carrying gatekeeper.exe, so install.ps1 can
  # be driven against the same fixture. It doubles as the second entry in
  # checksums.txt: the installer has to select its line by name rather than by
  # it being the only one.
  other="gatekeeper_${VERSION}_windows_amd64.zip"
  python3 - "$root/staging/gatekeeper" "$root/$TAG/$other" <<'PYEOF'
import stat, sys, zipfile

source, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    info = zipfile.ZipInfo("gatekeeper.exe", (2026, 1, 1, 0, 0, 0))
    # Expand-Archive on .NET restores the unix mode from the external
    # attributes, which is what lets the extracted "exe" run on the Linux host
    # the PowerShell tests use.
    info.external_attr = (stat.S_IFREG | 0o755) << 16
    with open(source, "rb") as handle:
        archive.writestr(info, handle.read())
PYEOF

  (cd "$root/$TAG" && {
    printf '%s  %s\n' "$(sha256_of "$other")" "$other"
    printf '%s  %s\n' "$(sha256_of "$name")" "$name"
  } > checksums.txt)

  printf '{"tag_name":"%s","name":"gatekeeper %s","draft":false,"prerelease":false}\n' \
    "$TAG" "$VERSION" > "$root/repos/$REPO/releases/latest"
}

# start_server serves $1 on a free loopback port and prints the base URL.
start_server() {
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$1" >/dev/null 2>&1 &
  server_pid=$!

  i=0
  while [ "$i" -lt 100 ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/$TAG/checksums.txt" 2>/dev/null; then
      printf 'http://127.0.0.1:%s' "$port"
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done
  echo 'install.test.sh: the fixture server never came up' >&2
  exit 1
}

# run_install invokes the installer against the fixture server and captures both
# streams and the exit status, without letting a failure abort this script.
run_install() {
  set +e
  out="$(
    GATEKEEPER_REPO="$REPO" \
    GATEKEEPER_BASE_URL="$base" \
    GATEKEEPER_API_URL="$base" \
    GATEKEEPER_VERSION='' \
    GATEKEEPER_INSTALL_DIR='' \
    GATEKEEPER_INSTALL_SOURCE_ONLY='' \
    sh "$install_sh" "$@" 2>&1
  )"
  status=$?
  set -e
}

# --- unit tests over the sourced functions ------------------------------------

unit_tests() {
  echo 'install.sh: name and version handling'
  # Assigned on its own line and unset again rather than as a prefix to `.`:
  # bash keeps an assignment that precedes a special builtin, and an exported
  # one would then turn every later `sh install.sh` in this file into a no-op.
  GATEKEEPER_INSTALL_SOURCE_ONLY=1
  # shellcheck source=./install.sh
  . "$install_sh"
  unset GATEKEEPER_INSTALL_SOURCE_ONLY

  expect_eq 'release_tag from a bare semver' "$(release_tag 0.1.0)" 'gatekeeper-v0.1.0'
  expect_eq 'release_tag from a v-prefixed semver' "$(release_tag v0.1.0)" 'gatekeeper-v0.1.0'
  expect_eq 'release_tag from a full tag' "$(release_tag gatekeeper-v0.1.0)" 'gatekeeper-v0.1.0'
  expect_eq 'release_tag of the nightly' "$(release_tag nightly)" 'gatekeeper-nightly'

  expect_eq 'version_token of a release tag' "$(version_token gatekeeper-v0.1.0)" '0.1.0'
  expect_eq 'version_token of the nightly tag' "$(version_token gatekeeper-nightly)" 'nightly'
  # A pre-release version keeps its own `-` suffix; only the tag prefix goes.
  expect_eq 'version_token of a pre-release' "$(version_token gatekeeper-v1.0.0-rc.1)" '1.0.0-rc.1'

  expect_eq 'archive_name on linux' "$(archive_name linux 0.1.0 amd64)" 'gatekeeper_0.1.0_linux_amd64.tar.gz'
  expect_eq 'archive_name on macOS' "$(archive_name darwin 0.1.0 arm64)" 'gatekeeper_0.1.0_darwin_arm64.tar.gz'
  expect_eq 'archive_name on Windows is a zip' "$(archive_name windows 0.1.0 amd64)" 'gatekeeper_0.1.0_windows_amd64.zip'

  echo 'install.sh: install directory and PATH helpers'

  # The destination has to be one the caller's shell will actually search, which
  # is what SUP-295 item 1 was about: a correct install the next command cannot
  # find is indistinguishable from a failed one.
  onpath="$workdir/home-onpath"
  mkdir -p "$onpath/.local/bin"
  # PATH carries the per-user bin and not /usr/local/bin, which is what pins the
  # preference on every host: as root in a container that system directory is
  # writable and searched, and would otherwise win here for the right reason.
  expect_eq 'default_install_dir takes a writable candidate already on PATH' \
    "$(HOME="$onpath" PATH="$onpath/.local/bin" default_install_dir)" "$onpath/.local/bin"

  offpath="$workdir/home-offpath"
  mkdir -p "$offpath"
  # Nothing of this HOME is on PATH and /usr/local/bin is either absent from the
  # candidate list or not writable, so the per-user directory is the fallback —
  # and the caller is told, rather than left to find out at the next command.
  expect_eq 'default_install_dir falls back to the per-user bin' \
    "$(HOME="$offpath" PATH="/nonexistent-for-this-test" default_install_dir)" "$offpath/.local/bin"

  mkdir -p "$workdir/exists"
  if writable_dir "$workdir/exists"; then pass 'writable_dir accepts a writable directory'; else
    fail 'writable_dir accepts a writable directory' 'said no'; fi
  if writable_dir "$workdir/exists/not-yet"; then pass 'writable_dir accepts one that can be created'; else
    fail 'writable_dir accepts one that can be created' 'said no'; fi
  if writable_dir /proc/nonexistent/bin; then
    fail 'writable_dir refuses an uncreatable directory' 'said yes'; else
    pass 'writable_dir refuses an uncreatable directory'; fi

  expect_eq 'rc_file_for zsh is .zshrc' "$(HOME=/h rc_file_for /bin/zsh)" '/h/.zshrc'
  # macOS Terminal opens a login shell (.bash_profile); a Linux terminal does not
  # (.bashrc). Writing to the other one is writing to nowhere.
  if [ "$(uname -s)" = Darwin ]; then
    expect_eq 'rc_file_for bash is .bash_profile on macOS' "$(HOME=/h rc_file_for /bin/bash)" '/h/.bash_profile'
  else
    expect_eq 'rc_file_for bash is .bashrc on Linux' "$(HOME=/h rc_file_for /bin/bash)" '/h/.bashrc'
  fi
  expect_eq 'rc_file_for guesses nothing for an unknown shell' "$(HOME=/h rc_file_for /bin/ksh)" ''

  # The console prints a PATH line of its own in the block a reader pastes
  # (`apps/router-ui/src/components/gatekeeper/install-commands.ts`). It has to
  # name the directory this script actually falls back to: a line for any other
  # one would fix nothing, and the two files are edited by different people.
  console="$here/../../apps/router-ui/src/components/gatekeeper/install-commands.ts"
  if [ -f "$console" ]; then
    expect_eq 'the fallback is the per-user bin' "$(HOME=/h PATH=/nonexistent-for-this-test default_install_dir)" \
      '/h/.local/bin'
    if grep -F 'export PATH="$HOME/.local/bin:$PATH"' "$console" >/dev/null 2>&1; then
      pass 'the console block puts that same directory on the PATH'
    else
      fail 'the console block puts that same directory on the PATH' \
        "no \$HOME/.local/bin PATH line in $console"
    fi
  fi

  # The file name reaches awk as data, so a name whose dots would match any
  # character as a regex still selects its own line and no other.
  sums="$workdir/checksums-unit.txt"
  printf 'aaaa  gatekeeper_1x0x0_linux_amd64.tar.gz\nbbbb  gatekeeper_1.0.0_linux_amd64.tar.gz\n' > "$sums"
  expect_eq 'expected_sha matches the exact file name' \
    "$(expected_sha "$sums" 'gatekeeper_1.0.0_linux_amd64.tar.gz')" 'bbbb'
  expect_eq 'expected_sha is empty for an unlisted file' \
    "$(expected_sha "$sums" 'gatekeeper_2.0.0_linux_amd64.tar.gz')" ''
}

# --- end-to-end tests over a served release -----------------------------------

# powershell_tests drives install.ps1 against the same fixture. PowerShell 7 on
# Linux is close enough to Windows PowerShell for everything the script does
# except the registry-backed PATH entry, which it skips off Windows; the
# end-to-end proof on a real Windows runner is the release workflow's
# `verify-install` matrix.
powershell_tests() {
  if ! command -v pwsh >/dev/null 2>&1; then
    echo 'install.ps1: skipped (pwsh is not installed)'
    return 0
  fi
  echo 'install.ps1: install from a release'

  dest="$workdir/win-bin"
  set +e
  out="$(pwsh -NoProfile -NonInteractive -File "$here/install.ps1" \
    -Repo "$REPO" -BaseUrl "$base" -ApiUrl "$base" -InstallDir "$dest" 2>&1)"
  status=$?
  set -e
  expect_eq 'a plain install succeeds' "$status" '0'
  expect_contains 'the checksum is reported as verified' "$out" 'Checksum OK'
  expect_contains 'the resolved version comes from the API' "$out" "Installing gatekeeper $VERSION"
  if [ -f "$dest/gatekeeper.exe" ]; then
    pass 'gatekeeper.exe is installed'
  else
    fail 'gatekeeper.exe is installed' "$dest/gatekeeper.exe is missing: $out"
  fi

  set +e
  out="$(pwsh -NoProfile -NonInteractive -File "$here/install.ps1" \
    -Repo "$REPO" -BaseUrl "file://$served" -ApiUrl "$base" -InstallDir "$workdir/win-offline" \
    -Version "$VERSION" 2>&1)"
  status=$?
  set -e
  expect_eq 'a file:// base URL succeeds' "$status" '0'
  expect_contains 'a file:// install still verifies the checksum' "$out" 'Checksum OK'

  set +e
  out="$(pwsh -NoProfile -NonInteractive -File "$here/install.ps1" \
    -Repo "$REPO" -BaseUrl "$base" -ApiUrl "$base" -InstallDir "$workdir/win-missing" \
    -Version 1.2.3 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    pass 'a version with no release fails'
  else
    fail 'a version with no release fails' "expected a non-zero exit, got 0: $out"
  fi
}

e2e_tests() {
  echo 'install.sh: install from a release'

  dest="$workdir/bin"

  run_install --install-dir "$dest"
  expect_eq 'a plain install succeeds' "$status" '0'
  if [ -x "$dest/gatekeeper" ]; then
    pass 'the binary is installed and executable'
  else
    fail 'the binary is installed and executable' "$dest/gatekeeper is missing or not executable: $out"
  fi
  expect_contains 'the checksum is reported as verified' "$out" 'Checksum OK'
  expect_contains 'the installed binary is run once' "$out" 'gatekeeper 9.9.9'
  expect_contains 'the resolved version comes from the API' "$out" "Installing gatekeeper $VERSION"
  expect_contains 'a destination off the PATH is called out' "$out" 'is not on your PATH'

  run_install --install-dir "$workdir/pinned" --version "$VERSION"
  expect_eq 'an explicit --version succeeds' "$status" '0'
  expect_contains 'an explicit --version needs no API call' "$out" "Installing gatekeeper $VERSION"

  run_install --install-dir "$workdir/pinned2" --version "$TAG"
  expect_eq 'a full tag is accepted as --version' "$status" '0'

  # The offline path the release workflow's smoke test takes: the same release
  # directory, reached with file:// instead of over the network.
  set +e
  out="$(
    GATEKEEPER_REPO="$REPO" sh "$install_sh" \
      --base-url "file://$served" --version "$VERSION" --install-dir "$workdir/offline" 2>&1
  )"
  status=$?
  set -e
  expect_eq 'a file:// base URL succeeds' "$status" '0'
  expect_contains 'a file:// install still verifies the checksum' "$out" 'Checksum OK'
}

# path_tests cover the close of the install: a destination the shell does not
# search is the failure SUP-295 item 1 reported, and the fix is only a fix if the
# next command in the console's copy-paste block works — in this terminal and in
# the next one.
path_tests() {
  echo 'install.sh: PATH handling'

  home="$workdir/home-zsh"
  dest="$home/.local/bin"
  mkdir -p "$home"

  set +e
  out="$(
    HOME="$home" SHELL=/bin/zsh \
      GATEKEEPER_REPO="$REPO" GATEKEEPER_BASE_URL="$base" GATEKEEPER_API_URL="$base" \
      sh "$install_sh" --install-dir "$dest" 2>&1
  )"
  status=$?
  set -e

  expect_eq 'an install off the PATH still succeeds' "$status" '0'
  expect_contains 'it says the directory is not on the PATH' "$out" 'is not on your PATH'
  expect_contains 'it names the startup file it wrote' "$out" "Added it to $home/.zshrc"
  # The line for *this* terminal: a script run through a pipe cannot export into
  # the shell that invoked it, so printing the line is the only thing it can do.
  expect_contains 'it prints the line for the current session' "$out" "export PATH=\"$dest:\$PATH\""

  if [ -f "$home/.zshrc" ]; then
    expect_contains 'the startup file carries the export' "$(cat "$home/.zshrc")" "export PATH=\"$dest:\$PATH\""
    expect_contains 'and says who wrote it' "$(cat "$home/.zshrc")" 'Confidential Router gatekeeper installer'
  else
    fail 'the startup file carries the export' "$home/.zshrc was not written: $out"
  fi

  # Installing again must not stack a second copy of the same line.
  set +e
  out="$(
    HOME="$home" SHELL=/bin/zsh \
      GATEKEEPER_REPO="$REPO" GATEKEEPER_BASE_URL="$base" GATEKEEPER_API_URL="$base" \
      sh "$install_sh" --install-dir "$dest" 2>&1
  )"
  status=$?
  set -e
  expect_eq 'a second install succeeds' "$status" '0'
  expect_eq 'it adds no second PATH line' "$(grep -c "export PATH=" "$home/.zshrc")" '1'
  expect_contains 'and says the file already covers it' "$out" 'already adds it'

  # --no-modify-path is the escape hatch for anyone who manages their own dotfiles.
  quiet="$workdir/home-quiet"
  mkdir -p "$quiet"
  set +e
  out="$(
    HOME="$quiet" SHELL=/bin/zsh \
      GATEKEEPER_REPO="$REPO" GATEKEEPER_BASE_URL="$base" GATEKEEPER_API_URL="$base" \
      sh "$install_sh" --install-dir "$quiet/.local/bin" --no-modify-path 2>&1
  )"
  status=$?
  set -e
  expect_eq '--no-modify-path still installs' "$status" '0'
  if [ -e "$quiet/.zshrc" ]; then
    fail '--no-modify-path writes no startup file' 'the file was written anyway'
  else
    pass '--no-modify-path writes no startup file'
  fi
  expect_contains '--no-modify-path still prints the session line' "$out" \
    "export PATH=\"$quiet/.local/bin:\$PATH\""

  # A destination the shell already searches needs none of this.
  searched="$workdir/searched"
  mkdir -p "$searched"
  set +e
  out="$(
    HOME="$workdir/home-none" SHELL=/bin/zsh PATH="$searched:$PATH" \
      GATEKEEPER_REPO="$REPO" GATEKEEPER_BASE_URL="$base" GATEKEEPER_API_URL="$base" \
      sh "$install_sh" --install-dir "$searched" 2>&1
  )"
  status=$?
  set -e
  expect_eq 'an install onto the PATH succeeds' "$status" '0'
  case "$out" in
    *'not on your PATH'*) fail 'an install onto the PATH says nothing about it' "it did: $out" ;;
    *) pass 'an install onto the PATH says nothing about it' ;;
  esac
}

# refusal_tests come last: they tamper with the served release, so nothing that
# expects a good one may run after them.
refusal_tests() {
  echo 'install.sh: refusals'

  run_install --install-dir "$workdir/never" --version 1.2.3
  expect_eq 'a version with no release fails' "$status" '1'
  if [ -e "$workdir/never/gatekeeper" ]; then
    fail 'a failed download installs nothing' 'the binary was installed anyway'
  else
    pass 'a failed download installs nothing'
  fi

  # Tamper with the archive after checksums.txt was written over it.
  printf 'tampered\n' >> "$served/$TAG/gatekeeper_${VERSION}_${host_os}_${host_arch}.tar.gz"
  run_install --install-dir "$workdir/tampered"
  expect_eq 'a tampered archive fails' "$status" '1'
  expect_contains 'a tampered archive says why' "$out" 'checksum mismatch'
  if [ -e "$workdir/tampered/gatekeeper" ]; then
    fail 'a tampered archive installs nothing' 'the binary was installed anyway'
  else
    pass 'a tampered archive installs nothing'
  fi

  # An archive that checksums.txt does not mention at all is refused for the
  # same reason a mismatching one is.
  : > "$served/$TAG/checksums.txt"
  run_install --install-dir "$workdir/unlisted"
  expect_eq 'an unlisted archive fails' "$status" '1'
  expect_contains 'an unlisted archive says why' "$out" 'not listed in checksums.txt'

  echo 'install.sh: unsupported platforms'

  stub="$workdir/stub"
  mkdir -p "$stub"
  cat > "$stub/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = '-m' ] && { echo mips64; exit 0; }
echo Linux
EOF
  chmod 0755 "$stub/uname"
  set +e
  out="$(PATH="$stub:$PATH" sh "$install_sh" --install-dir "$workdir/mips" 2>&1)"
  status=$?
  set -e
  expect_eq 'an unsupported CPU exits 3' "$status" '3'
  expect_contains 'an unsupported CPU says which' "$out" 'mips64'

  cat > "$stub/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = '-m' ] && { echo x86_64; exit 0; }
echo MINGW64_NT-10.0
EOF
  set +e
  out="$(PATH="$stub:$PATH" sh "$install_sh" --install-dir "$workdir/win" 2>&1)"
  status=$?
  set -e
  expect_eq 'Windows exits 3' "$status" '3'
  expect_contains 'Windows is redirected to install.ps1' "$out" 'install.ps1'

  echo 'install.sh: usage'

  set +e
  out="$(sh "$install_sh" --nonsense 2>&1)"
  status=$?
  set -e
  expect_eq 'an unknown flag exits 2' "$status" '2'

  set +e
  out="$(sh "$install_sh" --help 2>&1)"
  status=$?
  set -e
  expect_eq '--help exits 0' "$status" '0'
  expect_contains '--help documents the one-liner' "$out" 'curl -fsSL'
}

# --- main ---------------------------------------------------------------------

command -v python3 >/dev/null 2>&1 || { echo 'install.test.sh needs python3 to serve the fixture release' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'install.test.sh needs curl' >&2; exit 1; }

workdir="$(mktemp -d "${TMPDIR:-/tmp}/gatekeeper-install-test.XXXXXX")"
served="$workdir/served"

case "$(uname -s)" in
  Darwin) host_os=darwin ;;
  *) host_os=linux ;;
esac
case "$(uname -m)" in
  aarch64 | arm64) host_arch=arm64 ;;
  *) host_arch=amd64 ;;
esac

build_release "$served" "$host_os" "$host_arch"
base="$(start_server "$served")"

unit_tests
e2e_tests
path_tests
powershell_tests
refusal_tests

echo ''
if [ "$failures" -eq 0 ]; then
  echo 'install.sh: all checks passed'
else
  echo "install.sh: $failures check(s) failed"
  exit 1
fi
