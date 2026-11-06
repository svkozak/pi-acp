#!/usr/bin/env bash
# Run the local from-source pi-acp build as an ACP agent (for hydra).
# Uses the repo's tsx so edits under src/ take effect on the next session
# without a separate build step. Passes through "$@" so --terminal-login works.
exec /home/smagnuson/dev/pi-acp/node_modules/.bin/tsx \
  /home/smagnuson/dev/pi-acp/src/index.ts "$@"
