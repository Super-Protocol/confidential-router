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
