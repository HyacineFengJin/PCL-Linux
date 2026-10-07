#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$project_dir/prepare-icon.sh"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$applications_dir"

cat > "$applications_dir/pcl-linux-experimental.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=PCL RH
Name[zh_CN]=PCL RH
Comment=Launch existing Minecraft versions on Linux
Comment[zh_CN]=在 Linux 上启动已有的 Minecraft 版本
Exec="$project_dir/start-native.sh"
Path=$project_dir
Icon=$project_dir/assets/pcl-linux.png
Terminal=false
Categories=Game;
Keywords=Minecraft;PCL;Forge;
StartupNotify=true
StartupWMClass=pcl-desktop
EOF

desktop-file-validate "$applications_dir/pcl-linux-experimental.desktop"
printf '已安装应用入口：%s\n' "$applications_dir/pcl-linux-experimental.desktop"
