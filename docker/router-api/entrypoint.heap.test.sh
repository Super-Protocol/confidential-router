#!/bin/sh
#
# What `entrypoint.sh` decides about V8's heap ceiling (SUP-583).
#
# The entrypoint is the only place in the product that reads a cgroup, and the
# thing it got wrong cost production a total outage of the API and the console —
# so the arithmetic is worth a test even though it is nine lines of shell. It is
# driven through `CR_API_CGROUP_ROOT` and `node`'s own `-p`, so the whole thing
# runs on a laptop with no container at all.
#
#   sh docker/router-api/entrypoint.heap.test.sh
#
# Wired into CI as the `heap-ceiling` check of the router-api project.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
entrypoint="$here/entrypoint.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0

# Reports the `--max-old-space-size` the entrypoint settled on, or nothing when
# it left NODE_OPTIONS alone. `node -p` is the payload because it is the one
# interpreter the image is guaranteed to have, and it runs through the
# entrypoint's own "anything else runs verbatim" branch.
heap_of() {
  CR_API_CGROUP_ROOT="$1" NODE_OPTIONS="${2-}" sh "$entrypoint" node -p \
    "(process.env.NODE_OPTIONS||'').match(/--max-old-space-size=(\\d+)/)?.[1] ?? ''"
}

check() {
  what="$1"
  want="$2"
  got="$3"
  if [ "$want" = "$got" ]; then
    echo "ok — $what"
  else
    echo "FAIL — $what: wanted '$want', got '$got'"
    failures=$((failures + 1))
  fi
}

# cgroup v2, a 1Gi limit: the production shape. Three quarters of 1024 MiB.
v2=$work/v2
mkdir -p "$v2"
echo 1073741824 > "$v2/memory.max"
check 'a 1Gi cgroup v2 limit becomes a 768 MB heap' 768 "$(heap_of "$v2")"

# cgroup v1, same limit, same answer: the file moved, the question did not.
v1=$work/v1
mkdir -p "$v1/memory"
echo 1073741824 > "$v1/memory/memory.limit_in_bytes"
check 'a 1Gi cgroup v1 limit becomes a 768 MB heap' 768 "$(heap_of "$v1")"

# `max` is cgroup v2 for "no limit". Nothing to derive from, so nothing is said:
# Node's own default is the right answer when the container has the whole host.
unlimited=$work/unlimited
mkdir -p "$unlimited"
echo max > "$unlimited/memory.max"
check 'an unlimited cgroup leaves the default alone' '' "$(heap_of "$unlimited")"

# An unlimited cgroup v1 reports a number near 2^63 rather than a word, and
# three quarters of that is not a heap size.
huge=$work/huge
mkdir -p "$huge/memory"
echo 9223372036854771712 > "$huge/memory/memory.limit_in_bytes"
check 'an implausible v1 limit is read as no limit' '' "$(heap_of "$huge")"

# No cgroup files at all — a plain `docker run` on some kernels, and every
# non-Linux host.
absent=$work/absent
mkdir -p "$absent"
check 'no cgroup to read leaves the default alone' '' "$(heap_of "$absent")"

# A limit too small for a Node process to start in. Capping the heap there would
# turn a misconfiguration into a crash that looks like ours.
tiny=$work/tiny
mkdir -p "$tiny"
echo 134217728 > "$tiny/memory.max"
check 'a limit too small to serve from is left alone' '' "$(heap_of "$tiny")"

# An operator who named a number has a reason. 1Gi is present and ignored.
check 'an explicit --max-old-space-size wins' 256 "$(heap_of "$v2" '--max-old-space-size=256')"

# And an unrelated NODE_OPTIONS is extended, not replaced.
check 'other NODE_OPTIONS survive' 768 "$(heap_of "$v2" '--enable-source-maps')"
preserved=$(CR_API_CGROUP_ROOT="$v2" NODE_OPTIONS='--enable-source-maps' sh "$entrypoint" node -p \
  "process.env.NODE_OPTIONS.includes('--enable-source-maps')")
check 'other NODE_OPTIONS survive verbatim' true "$preserved"

# The ceiling reaches V8 and not just the environment: the point of the whole
# exercise is the number the heap is actually held to.
reported=$(CR_API_CGROUP_ROOT="$v2" sh "$entrypoint" node -p \
  "Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)")
if [ "$reported" -ge 700 ] && [ "$reported" -le 850 ]; then
  echo "ok — V8 reports a heap limit near 768 MB ($reported MB)"
else
  echo "FAIL — V8 reports $reported MB, wanted something near 768"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo 'every check passed'
