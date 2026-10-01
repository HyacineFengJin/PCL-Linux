#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$project_dir/assets"
curl -fsSL 'https://raw.githubusercontent.com/PCL-Community/PCL-CE/19805c446cfd17e92749124e3ab1c1832a291736/Plain%20Craft%20Launcher%202/Images/icon.ico' -o "$project_dir/assets/pcl-ce-icon.ico"
printf '%s  %s\n' '3874b40a1a87a7620751fcdbc0cfe3503c6e3c43818c3220019680dc5a9e54c3' "$project_dir/assets/pcl-ce-icon.ico" | sha256sum --check --status
python3 - "$project_dir/assets/pcl-ce-icon.ico" "$project_dir/assets/pcl-linux.png" <<'PY'
from pathlib import Path
import struct
import sys

raw = Path(sys.argv[1]).read_bytes()
_, kind, count = struct.unpack_from('<HHH', raw, 0)
if kind != 1:
    raise SystemExit('下载的文件不是 ICO 图标')
for index in range(count):
    width, height, _, _, _, _, size, offset = struct.unpack_from('<BBBBHHII', raw, 6 + index * 16)
    content = raw[offset:offset + size]
    if (width or 256) == 256 and (height or 256) == 256 and content.startswith(b'\x89PNG'):
        Path(sys.argv[2]).write_bytes(content)
        break
else:
    raise SystemExit('ICO 中没有 256px PNG 图标')
PY
printf '图标已准备：%s\n' "$project_dir/assets/pcl-linux.png"
