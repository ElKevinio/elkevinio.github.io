#!/bin/zsh
cd -- "${0:A:h}"
obs_node=$(command -v node)
if [[ -z "$obs_node" ]]; then
  obs_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$obs_node" ]]; then
  print 'Node.js wurde nicht gefunden. Bitte Node.js installieren und erneut starten.'
  read '?Enter zum Schließen …'
  exit 1
fi
exec "$obs_node" obs-relay.mjs
