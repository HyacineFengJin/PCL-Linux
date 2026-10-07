#!/bin/sh
set -eu

# Compatibility entry point for older build/install instructions.
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$project_dir/prepare-icon.sh"
