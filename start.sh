#!/bin/sh
# Fog chess launcher for macOS and Linux: runs the bundled JAS server
# (vendor/jas) on this repo's apps/ folder, on its own port so it can sit
# beside an everyday JAS on 4500.
set -e

script=$0
while [ -L "$script" ]; do
  link=$(readlink "$script")
  case $link in
    /*) script=$link ;;
    *) script=$(dirname "$script")/$link ;;
  esac
done
DIR=$(cd "$(dirname "$script")" && pwd)

# An empty submodule directory is the usual way a fresh clone breaks: the
# server then dies on a module-not-found that says nothing about submodules.
if [ ! -f "$DIR/vendor/jas/jas.sh" ] || [ ! -f "$DIR/vendor/obscuro-chess/vendor/obscuro/package.json" ]; then
  echo 'fog-chess: submodules missing, running git submodule update --init --recursive'
  git -C "$DIR" submodule update --init --recursive
fi

export JAS_APPS="$DIR/apps"
export JAS_DEFAULT_APP=fog-chess
export PORT="${PORT:-4510}"
echo "Fog chess: http://localhost:$PORT"
exec sh "$DIR/vendor/jas/jas.sh" "$@"
