#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Existing desktop entries and their undo records refer to this stable path.
# Keep it as a generated alias so replacing the artwork preserves ownership.
if ! cmp -s "$project_dir/assets/pcl-rh.png" "$project_dir/assets/pcl-linux.png"; then
    icon_temp=$(mktemp "$project_dir/assets/.pcl-icon.XXXXXX")
    trap 'rm -f "$icon_temp"' EXIT HUP INT TERM
    cp "$project_dir/assets/pcl-rh.png" "$icon_temp"
    chmod 644 "$icon_temp"
    mv -f "$icon_temp" "$project_dir/assets/pcl-linux.png"
fi
