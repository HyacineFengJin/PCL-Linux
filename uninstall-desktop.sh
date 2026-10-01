#!/bin/sh
set -eu
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
rm -f "$applications_dir/pcl-linux-experimental.desktop"
printf '已移除桌面入口。\n'
