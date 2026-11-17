#!/bin/sh
#
# What `entrypoint.sh` decides about V8's heap ceiling (SUP-583).
#
# The entrypoint is the only place in the product that reads a cgroup, and the
# thing it got wrong cost production a total outage of the API and the console —
# so the arithmetic is worth a test even though it is thirty lines of shell. It
# is driven through `CR_API_CGROUP_ROOT` and `node`'s own `-p`, so the whole
# thing runs on a laptop with no container at all.
#
#   sh docker/router-api/entrypoint.heap.test.sh
#
# **Every check that asks V8 a question asks for a property, not a number.** The
# first version of this file asserted "V8 reports ~682 MB", which was true on the
# Node the file was written on and false on the Node the image runs: V8 sizes the
# young generation from the memory it can see, so an old-space flag meant 730 MB
# on a 1 GiB container and 874 MB on an unconstrained CI runner. The entrypoint
# now pins both halves of the heap so the total is the same everywhere, and these
# checks state the two things that have to hold for that to be worth anything —
# the ceiling is the budget the entrypoint chose, and it leaves the container
# room to breathe — in a form that is honest on any Node and any host.
#
# Wired into CI as an unconditional step of the `nx` job.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
entrypoint="$here/entrypoint.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0

# The limit every fixture below uses, and the budget the entrypoint should derive
# from it: two thirds, for the whole heap.
LIMIT_BYTES=1073741824
LIMIT_MB=1024
BUDGET_MB=682

ok() { echo "ok — $1"; }
bad() {
  echo "FAIL — $1"
  failures=$((failures + 1))
}

# The flags the entrypoint settled on, or an empty string when it left
# NODE_OPTIONS alone. `node -p` is the payload because it is the one interpreter
# the image is guaranteed to have, and it runs through the entrypoint's own
# "anything else runs verbatim" branch.
flags_of() {
  CR_API_CGROUP_ROOT="$1" NODE_OPTIONS="${2-}" sh "$entrypoint" node -p \
    "(process.env.NODE_OPTIONS||'').match(/--max[-_]old[-_]space[-_]size=\\d+( --max-semi-space-size=\\d+)?/)?.[0] ?? ''"
}

# What V8 actually holds the heap to, in MB, through the real entrypoint. This is
# the only measurement that matters: the flags are a means to it.
ceiling_of() {
  CR_API_CGROUP_ROOT="$1" NODE_OPTIONS="${2-}" sh "$entrypoint" node -p \
    "Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)"
}

check() {
  what="$1"
  want="$2"
  got="$3"
  if [ "$want" = "$got" ]; then ok "$what"; else bad "$what: wanted '$want', got '$got'"; fi
}

# ---------------------------------------------------------------------------
# Which limits are derived from, and which are left alone
# ---------------------------------------------------------------------------

# cgroup v2, a 1Gi limit: the production shape. Two thirds of 1024 MiB as the
# whole-heap budget, less the three 16 MB semi-spaces of young generation.
v2=$work/v2
mkdir -p "$v2"
echo "$LIMIT_BYTES" > "$v2/memory.max"
check 'a 1Gi cgroup v2 limit derives both halves of the heap' \
  "--max-old-space-size=$((BUDGET_MB - 48)) --max-semi-space-size=16" "$(flags_of "$v2")"

# cgroup v1, same limit, same answer: the file moved, the question did not.
v1=$work/v1
mkdir -p "$v1/memory"
echo "$LIMIT_BYTES" > "$v1/memory/memory.limit_in_bytes"
check 'a 1Gi cgroup v1 limit derives the same' \
  "--max-old-space-size=$((BUDGET_MB - 48)) --max-semi-space-size=16" "$(flags_of "$v1")"

# `max` is cgroup v2 for "no limit". Nothing to derive from, so nothing is said:
# Node's own default is the right answer when the container has the whole host.
unlimited=$work/unlimited
mkdir -p "$unlimited"
echo max > "$unlimited/memory.max"
check 'an unlimited cgroup leaves the default alone' '' "$(flags_of "$unlimited")"

# An unlimited cgroup v1 reports a number near 2^63 rather than a word, and two
# thirds of that is not a heap size.
huge=$work/huge
mkdir -p "$huge/memory"
echo 9223372036854771712 > "$huge/memory/memory.limit_in_bytes"
check 'an implausible v1 limit is read as no limit' '' "$(flags_of "$huge")"

# No cgroup files at all — a plain `docker run` on some kernels, and every
# non-Linux host.
absent=$work/absent
mkdir -p "$absent"
check 'no cgroup to read leaves the default alone' '' "$(flags_of "$absent")"

# A limit too small for a Node process to start in. Capping the heap there would
# turn a misconfiguration into a crash that looks like ours.
tiny=$work/tiny
mkdir -p "$tiny"
echo 134217728 > "$tiny/memory.max"
check 'a limit too small to serve from is left alone' '' "$(flags_of "$tiny")"

# ---------------------------------------------------------------------------
# An operator's own numbers
# ---------------------------------------------------------------------------

# Four spellings, because V8 accepts dashes or underscores for either flag and an
# explicit cap silently losing to a derived one is exactly the surprise this
# block exists to remove. The property is the same every time and it is *not* a
# flag string: whatever the operator asked for is what V8 ends up holding, which
# here means a ceiling nowhere near the derived budget.
derived_ceiling=$(ceiling_of "$v2")
for spelling in '--max-old-space-size=256' '--max_old_space_size=256' \
  '--max-semi-space-size=4' '--max_semi_space_size=4'; do
  with_operator=$(ceiling_of "$v2" "$spelling")
  if [ "$with_operator" -lt "$derived_ceiling" ]; then
    ok "$spelling is the one V8 applied ($with_operator MB, against a derived $derived_ceiling MB)"
  else
    bad "$spelling was overridden: V8 reports $with_operator MB, the derived budget is $derived_ceiling MB"
  fi
done

# An unrelated NODE_OPTIONS is extended, not replaced.
check 'other NODE_OPTIONS survive' \
  "--max-old-space-size=$((BUDGET_MB - 48)) --max-semi-space-size=16" "$(flags_of "$v2" '--enable-source-maps')"
preserved=$(CR_API_CGROUP_ROOT="$v2" NODE_OPTIONS='--enable-source-maps' sh "$entrypoint" node -p \
  "process.env.NODE_OPTIONS.includes('--enable-source-maps')")
check 'other NODE_OPTIONS survive verbatim' true "$preserved"

# ---------------------------------------------------------------------------
# The two properties the whole exercise is for
# ---------------------------------------------------------------------------

# 1. The ceiling V8 holds is the budget the entrypoint chose — not that number
#    plus whatever V8 decided about the host's memory. This is what pinning the
#    semi-space buys, and without it this check cannot be written at all: the
#    same old-space flag yields 685 MB in a 512 MiB container and 874 MB on an
#    unconstrained runner. A few MB of slack for V8's own rounding.
if [ "$derived_ceiling" -ge $((BUDGET_MB - 8)) ] && [ "$derived_ceiling" -le $((BUDGET_MB + 8)) ]; then
  ok "V8 holds the heap to the derived budget ($derived_ceiling MB against $BUDGET_MB MB)"
else
  bad "V8 reports $derived_ceiling MB, the entrypoint derived a $BUDGET_MB MB budget — the young
      generation is not pinned, or the arithmetic drifted from the comment"
fi

# 2. And that budget leaves the container room for everything that is not the
#    JavaScript heap: the binary, code space, native allocations, stacks, the
#    bundle. A heap allowed past 75% of the limit invites the kernel's OOM
#    killer, which beats V8's own abort to the punch and prints nothing at all.
if [ "$derived_ceiling" -le $((LIMIT_MB * 3 / 4)) ]; then
  ok "it leaves $((LIMIT_MB - derived_ceiling)) MiB of a ${LIMIT_MB} MiB container for everything else"
else
  bad "a $derived_ceiling MiB heap in a ${LIMIT_MB} MiB container leaves too little for the rest"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo 'every check passed'
