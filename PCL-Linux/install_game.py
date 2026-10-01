#!/usr/bin/env python3
"""Install an official vanilla Minecraft Java version into an existing game root."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request
from pathlib import Path

MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
ASSET_URL = "https://resources.download.minecraft.net"
ROOT = (Path(__file__).resolve().parent.parent / "Minecraft" / ".minecraft").resolve()
VERSION_PATTERN = re.compile(r"[A-Za-z0-9._-]+\Z")
SHA1_PATTERN = re.compile(r"[0-9a-f]{40}\Z")


def remote_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "PCL-Linux-Experimental/0.2"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def manifest() -> dict:
    return remote_json(MANIFEST_URL)


def metadata(version: str) -> tuple[dict, dict]:
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError("非法版本号")
    record = next((x for x in manifest()["versions"] if x["id"] == version), None)
    if not record:
        raise ValueError(f"官方版本列表中找不到：{version}")
    data = remote_json(record["url"])
    if data.get("id") != version:
        raise ValueError("官方版本元数据 ID 不一致")
    return record, data


def inside(root: Path, relative: str) -> Path:
    if not relative or relative.startswith("/") or "\\" in relative:
        raise ValueError(f"非法相对路径：{relative}")
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"路径逃逸：{relative}")
    return path


def download(item: dict, target: Path) -> bool:
    sha1 = item.get("sha1", "").lower()
    if sha1 and not SHA1_PATTERN.fullmatch(sha1):
        raise ValueError(f"非法 SHA-1：{sha1}")
    if target.is_file() and (not item.get("size") or target.stat().st_size == item["size"]):
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + f".download-{os.getpid()}")
    try:
        request = urllib.request.Request(item["url"], headers={"User-Agent": "PCL-Linux-Experimental/0.2"})
        digest = hashlib.sha1()
        with urllib.request.urlopen(request, timeout=90) as response, temp.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
        if sha1 and digest.hexdigest() != sha1:
            raise ValueError(f"SHA-1 校验失败：{target}")
        if item.get("size") and temp.stat().st_size != item["size"]:
            raise ValueError(f"文件大小不符：{target}")
        temp.replace(target)
        return True
    finally:
        temp.unlink(missing_ok=True)


def normalize_natives(data: dict) -> None:
    """Expose Mojang classifier natives as libraries understood by launcher.py."""
    synthetic = []
    for lib in data.get("libraries", []):
        classifier = lib.get("natives", {}).get("linux", "").replace("${arch}", "64")
        native = lib.get("downloads", {}).get("classifiers", {}).get(classifier)
        if native:
            synthetic.append({
                "name": lib["name"] + ":" + classifier,
                "downloads": {"artifact": native},
                "rules": lib.get("rules") or [{"action": "allow", "os": {"name": "linux"}}],
            })
    data.setdefault("libraries", []).extend(synthetic)


def install(root: Path, version: str) -> dict:
    root = root.expanduser().resolve()
    record, data = metadata(version)
    version_dir = inside(root / "versions", version)
    version_json = version_dir / (version + ".json")
    if version_json.exists():
        raise FileExistsError(f"版本已存在，不会覆盖：{version_json}")
    normalize_natives(data)
    version_dir.mkdir(parents=True, exist_ok=True)
    client = data.get("downloads", {}).get("client")
    if not client:
        raise ValueError("该版本没有可下载的客户端")
    print(f"下载 Minecraft {version} 游戏核心……", flush=True)
    download(client, version_dir / (version + ".jar"))
    import launcher  # Reuse its OS rules and native extraction.
    libraries = 0
    for lib in data.get("libraries", []):
        if not launcher.library_allowed(lib):
            continue
        item = lib.get("downloads", {}).get("artifact")
        if not item:
            continue
        target = inside(root / "libraries", item["path"])
        if download(item, target):
            libraries += 1
    index = data.get("assetIndex")
    assets_downloaded = 0
    if index:
        index_path = inside(root / "assets" / "indexes", index["id"] + ".json")
        download(index, index_path)
        objects = json.loads(index_path.read_text(encoding="utf-8"))["objects"]
        jobs = []
        seen = set()
        for info in objects.values():
            sha1 = info["hash"]
            if not SHA1_PATTERN.fullmatch(sha1):
                raise ValueError("资源索引含有非法 SHA-1")
            if sha1 in seen:
                continue
            seen.add(sha1)
            target = root / "assets" / "objects" / sha1[:2] / sha1
            if target.is_file() and target.stat().st_size == info["size"]:
                continue
            jobs.append(({"url": f"{ASSET_URL}/{sha1[:2]}/{sha1}", "sha1": sha1, "size": info["size"]}, target))
        print(f"下载 {len(jobs)} 个缺少的资源对象……", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(download, item, target) for item, target in jobs]
            for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
                if future.result():
                    assets_downloaded += 1
                if completed % 100 == 0 or completed == len(jobs):
                    print(f"资源进度：{completed}/{len(jobs)}", flush=True)
    pending = version_json.with_suffix(".json.download")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    pending.replace(version_json)
    return {"version": version, "libraries": libraries, "assets": assets_downloaded, "java": data.get("javaVersion", {}).get("majorVersion")}


def main() -> int:
    parser = argparse.ArgumentParser(description="安装 Mojang 官方 Minecraft Java 版本")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--catalog", action="store_true", help="列出最新官方版本")
    parser.add_argument("--plan", metavar="VERSION", help="查看版本需求")
    parser.add_argument("--install", metavar="VERSION", help="下载安装该版本")
    args = parser.parse_args()
    try:
        if args.catalog:
            listing = manifest()
            print("最新版本：", listing["latest"])
            for row in listing["versions"][:20]:
                print(f"{row['id']}  {row['type']}  {row['releaseTime']}")
        elif args.plan:
            _, data = metadata(args.plan)
            print(json.dumps({"id": data["id"], "type": data.get("type"), "java": data.get("javaVersion", {}).get("majorVersion"), "libraries": len(data.get("libraries", [])), "assets": data.get("assetIndex", {}).get("id")}, ensure_ascii=False, indent=2))
        elif args.install:
            print(json.dumps(install(args.root, args.install), ensure_ascii=False, indent=2))
        else:
            parser.print_help()
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"安装失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
