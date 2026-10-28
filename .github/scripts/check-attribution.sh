#!/usr/bin/env bash
# Commits on `main` record human authorship only: no tool or assistant
# attribution trailers, and no robot emoji advertising one.
#
# A squash merge copies the pull request title and body into the commit
# verbatim, and co-author trailers travel on the branch commits themselves, so
# all three sources are checked here rather than only the subject line.
set -euo pipefail

robot=$'\U0001F916'
pattern="co-authored-by:[[:space:]]*(claude|cursor|copilot|chatgpt|codex|gemini|devin|aider)\b"
pattern+="|co-authored-by:.*@(anthropic|openai|cursor)\."
pattern+="|generated with \[(claude|codex|cursor|copilot|gemini)"
pattern+="|$robot"

fail=0

check() {
  local what=$1 text=$2 hits
  hits=$(printf '%s' "$text" | grep -niE "$pattern" || true)
  if [[ -n $hits ]]; then
    echo "::error::$what carries an attribution trailer:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    fail=1
  fi
}

check "The pull request title" "${PR_TITLE:-}"
check "The pull request body" "${PR_BODY:-}"

if [[ -n ${BASE_SHA:-} && -n ${HEAD_SHA:-} ]]; then
  while read -r sha; do
    [[ -z $sha ]] && continue
    check "Commit ${sha:0:8}" "$(git log -1 --format='%B' "$sha")"
  done < <(git rev-list "$BASE_SHA".."$HEAD_SHA")
fi

if (( fail )); then
  cat >&2 <<'MSG'

Remove the trailer and amend the commit (or edit the pull request text).
A co-author trailer is for a person who worked on the change.
MSG
  exit 1
fi

echo "No attribution trailers found."
