#!/bin/sh
#
# Entrypoint of the router-api image.
#
#   docker run … router-api            # serve (the image CMD)
#   docker run … router-api migrate    # apply every pending migration, then exit
#   docker run … router-api node -e …  # anything else runs verbatim
#
# `migrate` is what a deployment runs once, from a job or an init container,
# before the replicas roll. On PostgreSQL `database.migrationsRun` is off by
# default precisely so replicas do not race one another at boot, which makes
# this the only thing that applies the schema — see apps/router-api/README.md.
set -eu

# ---------------------------------------------------------------------------
# The heap ceiling, from the limit this container actually has (SUP-583)
# ---------------------------------------------------------------------------
#
# Node sizes V8's heap from the memory it can see, and in a container that *is*
# the cgroup limit — libuv reports the constrained value and V8 takes roughly
# half of it. `node:24-alpine` under `--memory=1g` reports a `heap_size_limit`
# of 560 MB, which is the ceiling production's API aborted at on 2026-10-28:
#
#   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
#   memory
#
# Half is a sensible default for a machine with other work on it; for a
# container whose entire purpose is this process it leaves 45% of the allowance
# untouched and the process kills itself rather than collecting.
#
# Two thirds instead — but of the *whole* heap, and that distinction is the
# point. `--max-old-space-size` bounds only the old space; V8 adds three
# semi-spaces of young generation on top, and it sizes those from the memory it
# can see, so the same flag means different totals in different places:
#
#   container   V8's own semi-space   heap_size_limit at --max-old-space-size=682
#   512 MiB      1 MB                  685 MB
#   1 GiB       16 MB                  730 MB
#   2 GiB       32 MB                  778 MB
#   4 GiB+      64 MB                  874 MB
#   unlimited   64 MB                  874 MB
#
# (measured on `node:24-alpine`, the image's own base). An old-space number
# alone is therefore not a ceiling at all: it is a ceiling plus whatever V8
# decided about the host. Pinning the semi-space as well makes the total what
# this block says it is — 682 MB in every one of those rows — which is both the
# safety property and the only reason a test of it can be honest.
#
# 16 MB is V8's own choice for a 1 GiB container, the shape this chart ships, so
# the pin states that choice rather than overriding it. A much larger limit
# would have had a larger young generation and may want one back; an explicit
# `--max-semi-space-size` in NODE_OPTIONS is how to ask.
#
# What the remaining third is for: the binary, code space, native allocations,
# stacks, the loaded bundle. Three quarters would reach 80% of the container and
# invite the kernel's OOM killer, which is the worse way to learn the same thing
# — V8's abort at least prints the GC record above, and exit 137 prints nothing.
# A heavy query that aborted at 560 MB now meets GC pressure, which is the
# failure an operator can act on.
#
# `CR_API_CGROUP_ROOT` exists so `entrypoint.heap.test.sh` can hand this a
# directory of fixtures instead of the real one. Nothing in production sets it.

# The young generation, as three semi-spaces of this many MB. Keep in step with
# `heap_budget_mb` below, which subtracts it.
CR_API_SEMI_SPACE_MB=16

# Two thirds of the container, as the ceiling for the whole heap — old space and
# young generation together. Prints nothing when there is no limit worth
# deriving from.
heap_budget_mb() {
  cgroup="${CR_API_CGROUP_ROOT:-/sys/fs/cgroup}"
  # cgroup v2 first, then v1. `max` means unlimited, and on v1 an unlimited
  # cgroup reports a number near 2^63, so anything implausibly large is read as
  # "no limit" too.
  limit=""
  if [ -r "$cgroup/memory.max" ]; then
    limit=$(cat "$cgroup/memory.max")
  elif [ -r "$cgroup/memory/memory.limit_in_bytes" ]; then
    limit=$(cat "$cgroup/memory/memory.limit_in_bytes")
  fi
  case "$limit" in
    '' | max | *[!0-9]*) return 0 ;;
  esac
  # 1 TiB. Above this it is the host's memory wearing a cgroup's clothes.
  [ "$limit" -le 1099511627776 ] || return 0
  budget=$((limit / 1024 / 1024 * 2 / 3))
  # Below 128 MB a Node process has no room to start, let alone serve; a limit
  # that small is a misconfiguration and capping the heap would only turn it
  # into a confusing crash. The floor is on the whole budget, so the old space
  # left after the young generation is still worth having.
  [ "$budget" -ge 128 ] || return 0
  echo "$budget"
}

# An explicit number in NODE_OPTIONS wins: an operator who has named one has a
# reason, and this must not argue with it. Both spellings of each flag, because
# V8 accepts either and `--max_old_space_size=256` silently losing to a derived
# 634 would be exactly the surprise this block exists to remove.
#
# **Each flag independently.** The first version of this skipped both whenever
# either was present — "two halves of one ceiling" — and that was backwards: an
# operator who tunes only the young generation would have had the old space fall
# all the way back to Node's *unconstrained* default, which in a 1 GiB container
# is a 4 GB ceiling. Tuning the young generation is not a statement about the
# ceiling, and the ceiling is the thing this block is here to protect.
budget_mb=$(heap_budget_mb)
if [ -n "$budget_mb" ]; then
  case "${NODE_OPTIONS:-}" in
    *--max-old-space-size* | *--max_old_space_size*) ;;
    *)
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$((budget_mb - 3 * CR_API_SEMI_SPACE_MB))"
      export NODE_OPTIONS
      ;;
  esac
  case "${NODE_OPTIONS:-}" in
    *--max-semi-space-size* | *--max_semi_space_size*) ;;
    *)
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-semi-space-size=$CR_API_SEMI_SPACE_MB"
      export NODE_OPTIONS
      ;;
  esac
fi

command="${1:-serve}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  serve)
    exec node /app/main.js "$@"
    ;;
  migrate)
    exec node /app/cli/run-migrations.js "$@"
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
