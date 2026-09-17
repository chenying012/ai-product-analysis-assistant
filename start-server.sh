#!/bin/sh
# Starts the production server with accounts enabled.
#
# The SQLite flag is applied here rather than through the deploy command's environment because the
# platform strips quoted values, which silently dropped NODE_OPTIONS and left the account routes
# failing at runtime. Node reads NODE_OPTIONS from the process it actually spawns, so exporting it in
# this script is reliable.
set -e
cd "$(dirname "$0")"
export ACCOUNTS_DB="${ACCOUNTS_DB:-on}"
export NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning"
exec npx next start --hostname 0.0.0.0 --port "${PORT:-3000}"
