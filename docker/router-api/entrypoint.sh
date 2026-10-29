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
# Node sizes V8's old space from the memory it can see, and in a container that
# *is* the cgroup limit — libuv reports the constrained value and V8 takes
# roughly half of it. So a container limited to 1Gi gets a heap ceiling near
# 512 MB and aborts there:
#
#   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
#   memory
#
# which is what took production's API and console down for ten seconds on
# 2026-10-28, with 45% of the container's allowance never touched. Half is a
# sensible default for a machine that has other work on it; for a container
# whose entire purpose is this process it leaves most of the budget unused, and
# the process kills itself rather than collecting.
#
# Three quarters instead. The rest is the room everything outside the old space
# needs — the binary, buffers, native allocations, stacks, young generation —
# and overrunning it means the kernel's OOM killer instead of V8's abort, which
# is a worse way to learn the same thing. A heavy query that would have aborted
# at 512 MB now meets GC pressure, which is the failure mode an operator can
# act on.
#
# `CR_API_CGROUP_ROOT` exists so `entrypoint.heap.test.sh` can hand this a
# directory of fixtures instead of the real one. Nothing in production sets it.
#
# An explicit `--max-old-space-size` in NODE_OPTIONS wins: an operator who has
# named a number has a reason, and this must not argue with it.
node_heap_mb() {
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
  mb=$((limit / 1024 / 1024 * 3 / 4))
  # Below 128 MB a Node process has no room to start, let alone serve; a limit
  # that small is a misconfiguration and capping the heap would only turn it
  # into a confusing crash.
  [ "$mb" -ge 128 ] || return 0
  echo "$mb"
}

case "${NODE_OPTIONS:-}" in
  *--max-old-space-size*) ;;
  *)
    heap_mb=$(node_heap_mb)
    if [ -n "$heap_mb" ]; then
      NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$heap_mb"
      export NODE_OPTIONS
    fi
    ;;
esac

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
