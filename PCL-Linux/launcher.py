#!/usr/bin/env python3
"""Small, independent Linux launcher for existing Minecraft installations.

Reads Mojang's version JSON format. This is not a port of PCL CE's UI/code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import uuid
import zipfile
import auth
import install_game
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = (HERE.parent / "Minecraft" / ".minecraft").resolve()
DEFAULT_JAVA = HERE / "runtime" / "bin" / "java"
LAUNCHER_NAME = "PCL-Linux-Experimental"
OS_NAME = "linux"
ARCH = "x86_64" if platform.machine().lower() in ("x86_64", "amd64") else platform.machine().lower()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def versions(root: Path) -> list[str]:
    base = root / "versions"
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir() if p.is_dir() and (p / (p.name + ".json")).is_file())


def version_data(root: Path, version: str) -> tuple[dict, Path]:
    folder = root / "versions" / version
    path = folder / (version + ".json")
    if not path.is_file():
        raise ValueError(f"找不到版本配置：{path}")
    data = read_json(path)
    parent = data.get("inheritsFrom")
    if parent:
        base, _ = version_data(root, parent)
        combined = {**base, **data}
        combined["libraries"] = base.get("libraries", []) + data.get("libraries", [])
        combined["arguments"] = {
            k: base.get("arguments", {}).get(k, []) + data.get("arguments", {}).get(k, [])
            for k in ("game", "jvm")
        }
        for key in ("assetIndex", "assets", "downloads", "logging"):
            if key not in data and key in base:
                combined[key] = base[key]
        data = combined
    return data, folder


def rule_matches(rule: dict) -> bool:
    os_rule = rule.get("os", {})
    if os_rule.get("name") and os_rule["name"] != OS_NAME:
        return False
    if os_rule.get("arch") and not re.fullmatch(os_rule["arch"], ARCH):
        return False
    if os_rule.get("version") and not re.search(os_rule["version"], platform.release()):
        return False
    features = rule.get("features", {})
    return not any(bool(value) for value in features.values())


def allowed(entry: dict) -> bool:
    rules = entry.get("rules")
    if not rules:
        return True
    result = False
    for rule in rules:
        if rule_matches(rule):
            result = rule.get("action") == "allow"
    return result


def library_allowed(lib: dict) -> bool:
    if not allowed(lib):
        return False
    name = lib.get("name", "")
    # Some Mojang descriptors mark both architectures with only os=linux.
    if ARCH == "x86_64" and ("linux-aarch_64" in name or "linux-arm64" in name):
        return False
    if ARCH in ("aarch64", "arm64") and "linux-x86_64" in name:
        return False
    return True


def download(item: dict, destination: Path) -> None:
    url = item.get("url")
    if not url:
        raise ValueError(f"缺少下载地址：{destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(destination.name + ".download")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": LAUNCHER_NAME})
        with urllib.request.urlopen(req, timeout=60) as source, temp.open("wb") as target:
            shutil.copyfileobj(source, target)
        expected = item.get("sha1")
        if expected and hashlib.sha1(temp.read_bytes()).hexdigest().lower() != expected.lower():
            raise ValueError(f"SHA-1 校验失败：{destination}")
        temp.replace(destination)
    finally:
        temp.unlink(missing_ok=True)


def native_archive(lib: dict) -> bool:
    name = lib.get("name", "")
    return "natives-linux" in name or "linux-x86_64" in name or "linux-aarch_64" in name


def extract_natives(archive: Path, folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as jar:
        for item in jar.infolist():
            filename = Path(item.filename).name
            if not re.search(r"\.so(?:\.\d+)*$", filename):
                continue
            target = folder / filename
            if not target.exists():
                with jar.open(item) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)


def prepare(root: Path, version: str, fetch: bool = True) -> tuple[dict, Path, list[Path], Path]:
    data, folder = version_data(root, version)
    libroot = root / "libraries"
    natives = root / ".pcl-linux" / "natives" / version
    classpath = []
    missing = []
    for lib in data.get("libraries", []):
        if not library_allowed(lib):
            continue
        artifact = lib.get("downloads", {}).get("artifact")
        if not artifact:
            continue
        path = libroot / artifact["path"]
        if not path.is_file():
            if fetch:
                print(f"下载依赖：{lib['name']}", flush=True)
                download(artifact, path)
            else:
                missing.append(str(path))
        if path.is_file():
            if native_archive(lib):
                extract_natives(path, natives)
            else:
                classpath.append(path)
    jar = folder / (version + ".jar")
    if not jar.is_file():
        client = data.get("downloads", {}).get("client")
        if fetch and client:
            print(f"下载游戏核心：{version}", flush=True)
            download(client, jar)
        else:
            missing.append(str(jar))
    if jar.is_file():
        classpath.append(jar)
    index = data.get("assetIndex", {})
    if index:
        path = root / "assets" / "indexes" / (index["id"] + ".json")
        if not path.is_file():
            if fetch:
                print(f"下载资源索引：{index['id']}", flush=True)
                download(index, path)
            else:
                missing.append(str(path))
    logging = data.get("logging", {}).get("client", {})
    if logging.get("file"):
        item = logging["file"]
        path = root / "assets" / "log_configs" / item["id"]
        if not path.is_file():
            if fetch:
                print(f"下载日志配置：{item['id']}", flush=True)
                download(item, path)
            else:
                missing.append(str(path))
    if missing:
        raise FileNotFoundError("缺少文件：\n" + "\n".join(missing))
    return data, folder, classpath, natives


def expand_args(raw: list, replacements: dict[str, str]) -> list[str]:
    result = []
    for entry in raw:
        if isinstance(entry, dict):
            if not allowed(entry):
                continue
            entry = entry.get("value", [])
        for value in entry if isinstance(entry, list) else [entry]:
            for key, replacement in replacements.items():
                value = value.replace("${" + key + "}", replacement)
            if "${" in value:
                raise ValueError(f"尚未支持的启动参数：{value}")
            result.append(value)
    return result


def game_dir(root: Path, folder: Path) -> Path:
    # PCL isolated versions keep their own mods, saves, configs and options.
    return folder if any((folder / name).exists() for name in ("mods", "saves", "config", "options.txt")) else root


def java_major(path: Path) -> int | None:
    try:
        result = subprocess.run([str(path), "-version"], capture_output=True, text=True, timeout=10)
        match = re.search(r'version "(?:1\.)?(\d+)', result.stderr + result.stdout)
        return int(match.group(1)) if match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def choose_java(data: dict) -> Path:
    required = int(data.get("javaVersion", {}).get("majorVersion", 17))
    candidates = [DEFAULT_JAVA, HERE / "runtime-25" / "bin" / "java"]
    system = shutil.which("java")
    if system:
        candidates.append(Path(system))
    jvm_root = Path("/usr/lib/jvm")
    if jvm_root.is_dir():
        candidates.extend(jvm_root.glob("*/bin/java"))
    usable = []
    for path in dict.fromkeys(p.resolve() for p in candidates if p.is_file()):
        major = java_major(path)
        if major and major >= required:
            usable.append((major, path))
    if not usable:
        raise FileNotFoundError(f"此版本需要 Java {required} 或更新版本；请使用 --java 指定安装好的 Java")
    # Prefer an exact major release: modded versions may reject newer runtimes.
    return min(usable, key=lambda item: (item[0] != required, item[0]))[1]


def command(root: Path, version: str, player: str, java: Path | None, memory: int, fetch: bool = True, online: bool = False) -> tuple[list[str], Path]:
    account = auth.session(root) if online else None
    if account:
        player = account["name"]
    if not account and not re.fullmatch(r"[A-Za-z0-9_]{3,16}", player):
        raise ValueError("离线玩家名需为 3–16 位英文字母、数字或下划线")
    if memory < 2 or memory > 64:
        raise ValueError("内存需为 2–64 GiB")
    data, folder, classpath, natives = prepare(root, version, fetch)
    java = java or choose_java(data)
    if not java.is_file():
        raise FileNotFoundError(f"找不到 Java：{java}")
    where = game_dir(root, folder)
    offline_uuid = uuid.UUID(bytes=hashlib.md5(("OfflinePlayer:" + player).encode()).digest(), version=3)
    replacements = {
        "auth_player_name": player,
        "version_name": version,
        "game_directory": str(where),
        "assets_root": str(root / "assets"),
        "assets_index_name": data.get("assets", data.get("assetIndex", {}).get("id", "")),
        "auth_uuid": account["uuid"] if account else offline_uuid.hex,
        "auth_access_token": account["access_token"] if account else "0",
        "clientid": account["client_id"] if account else "0",
        "auth_xuid": account.get("xuid", "") if account else "0",
        "user_type": "msa" if account else "legacy",
        "user_properties": "{}",
        "auth_session": "token:" + account["access_token"] + ":" + account["uuid"] if account else "0",
        "version_type": data.get("type", "release"),
        "natives_directory": str(natives),
        "launcher_name": LAUNCHER_NAME,
        "launcher_version": "0.1",
        "classpath": os.pathsep.join(str(p) for p in classpath),
        "classpath_separator": os.pathsep,
        "library_directory": str(root / "libraries"),
    }
    args = data.get("arguments", {})
    if args:
        jvm = expand_args(args.get("jvm", []), replacements)
        game = expand_args(args.get("game", []), replacements)
    else:
        jvm = ["-Djava.library.path=" + str(natives), "-cp", replacements["classpath"]]
        game = expand_args(data.get("minecraftArguments", "").split(), replacements)
    logging = data.get("logging", {}).get("client", {})
    if logging.get("file"):
        log_path = root / "assets" / "log_configs" / logging["file"]["id"]
        jvm.append(logging["argument"].replace("${path}", str(log_path)))
    cmd = [str(java), f"-Xmx{memory}G", *jvm, data["mainClass"], *game]
    return cmd, where


def main() -> int:
    parser = argparse.ArgumentParser(description="PCL Linux 实验版：启动已有的 Minecraft 版本")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=".minecraft 目录")
    parser.add_argument("--java", type=Path, help="指定 Java 可执行文件；默认按版本自动选择")
    parser.add_argument("--player", default="Player", help="离线玩家名")
    parser.add_argument("--memory", type=int, default=8, help="最大内存，GiB")
    parser.add_argument("--login", action="store_true", help="登录微软账号（需配置客户端 ID）")
    parser.add_argument("--logout", action="store_true", help="删除本地账号缓存")
    parser.add_argument("--online", action="store_true", help="使用已登录的正版账号启动")
    parser.add_argument("--client-id", default=os.environ.get("PCL_LINUX_CLIENT_ID", ""), help="此项目注册的微软公共客户端 ID")
    parser.add_argument("--list", action="store_true", help="列出版本")
    parser.add_argument("--catalog", action="store_true", help="列出最新的官方可安装版本")
    parser.add_argument("--install", metavar="VERSION", help="安装 Mojang 官方原版版本")
    parser.add_argument("--check", metavar="VERSION", help="离线检查所需文件")
    parser.add_argument("--prepare", metavar="VERSION", help="补齐 Linux 依赖")
    parser.add_argument("--dry-run", metavar="VERSION", help="检查并显示启动概要")
    parser.add_argument("--launch", metavar="VERSION", help="启动版本")
    ns = parser.parse_args()
    root = ns.root.expanduser().resolve()
    java = ns.java.expanduser().resolve() if ns.java else None
    try:
        if ns.logout:
            auth.logout(root)
            print("已删除本地账号缓存")
            return 0
        if ns.login:
            account = auth.login(root, ns.client_id, lambda url, code: print(f"在浏览器打开 {url}，输入验证码 {code}", flush=True))
            print(f"已登录：{account['name']}")
            return 0
        if ns.list:
            print("\n".join(versions(root)))
            return 0
        if ns.catalog:
            listing = install_game.manifest()
            print("最新版本：", listing["latest"])
            for row in listing["versions"][:20]:
                print(f"{row['id']}  {row['type']}  {row['releaseTime']}")
            return 0
        if ns.install:
            print(json.dumps(install_game.install(root, ns.install), ensure_ascii=False, indent=2))
            return 0
        if ns.check:
            data, folder, cp, natives = prepare(root, ns.check, fetch=False)
            print(f"就绪：{ns.check}，{len(cp)} 个类路径文件，游戏目录 {game_dir(root, folder)}")
            return 0
        if ns.prepare:
            prepare(root, ns.prepare)
            print(f"Linux 依赖已准备：{ns.prepare}")
            return 0
        if ns.dry_run or ns.launch:
            version = ns.dry_run or ns.launch
            cmd, where = command(root, version, ns.player, java, ns.memory, online=ns.online)
            print(f"版本：{version}\nJava：{cmd[0]}\n游戏目录：{where}\n参数个数：{len(cmd)}")
            if ns.launch:
                log_dir = root / ".pcl-linux" / "logs"
                log_dir.mkdir(parents=True, exist_ok=True)
                log = log_dir / (version + ".log")
                with log.open("w", encoding="utf-8") as output:
                    process = subprocess.Popen(cmd, cwd=where, stdout=output, stderr=subprocess.STDOUT)
                    print(f"游戏进程：{process.pid}\n日志：{log}")
                    return process.wait()
            return 0
        show_gui(root, java, ns.player, ns.memory, ns.client_id, ns.online)
        return 0
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1


def show_gui(root: Path, java: Path | None, player: str, memory: int, client_id: str = "", online: bool = False) -> None:
    import tkinter as tk
    from tkinter import messagebox, ttk

    window = tk.Tk()
    window.title("PCL Linux · 实验版")
    window.geometry("680x610")
    window.configure(bg="#17212b")
    style = ttk.Style(window)
    style.theme_use("clam")
    style.configure("TFrame", background="#17212b")
    style.configure("TLabel", background="#17212b", foreground="#e8edf1", font=("Sans", 11))
    style.configure("TButton", font=("Sans", 11), padding=7)
    frame = ttk.Frame(window, padding=22)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="PCL Linux · 实验版", font=("Sans", 20, "bold")).pack(anchor="w")
    ttk.Label(frame, text=f"游戏目录：{root}", wraplength=600).pack(anchor="w", pady=(8, 20))
    account = auth.account_info(root)
    online_var = tk.BooleanVar(value=online or bool(account))
    account_label = tk.StringVar(value="微软账号：" + (account["name"] if account else "未登录"))
    ttk.Label(frame, textvariable=account_label).pack(anchor="w")
    account_row = ttk.Frame(frame)
    account_row.pack(fill="x", pady=(4, 12))
    ttk.Checkbutton(account_row, text="使用微软账号启动", variable=online_var).pack(side="left")
    login_cancel = threading.Event()

    def account_done(message, error=False):
        login_button.configure(state="normal")
        logout_button.configure(state="normal")
        status.set(message)
        info = auth.account_info(root)
        account_label.set("微软账号：" + (info["name"] if info else "未登录"))
        if info and not error:
            online_var.set(True)
        if error:
            messagebox.showerror("登录失败", message)

    def show_device(url, code):
        import webbrowser
        status.set(f"请在 {url} 输入验证码：{code}")
        webbrowser.open(url)

    def login_worker():
        try:
            info = auth.login(root, client_id, lambda url, code: window.after(0, show_device, url, code), login_cancel)
            window.after(0, account_done, "已登录：" + info["name"])
        except Exception as error:
            window.after(0, account_done, str(error), True)

    def start_login():
        login_cancel.clear()
        login_button.configure(state="disabled")
        logout_button.configure(state="disabled")
        status.set("正在获取微软登录验证码……")
        threading.Thread(target=login_worker, daemon=True).start()

    def sign_out():
        auth.logout(root)
        online_var.set(False)
        account_done("已删除本地账号缓存")

    login_button = ttk.Button(account_row, text="微软登录", command=start_login)
    login_button.pack(side="left", padx=8)
    logout_button = ttk.Button(account_row, text="退出账号", command=sign_out)
    logout_button.pack(side="left")
    names = versions(root)
    chosen = tk.StringVar(value=names[0] if names else "")
    ttk.Label(frame, text="游戏版本").pack(anchor="w")
    combo = ttk.Combobox(frame, textvariable=chosen, values=names, state="readonly", width=58)
    combo.pack(anchor="w", fill="x", pady=(3, 12))
    ttk.Label(frame, text="安装官方原版版本（例如 1.21.1）").pack(anchor="w")
    install_row = ttk.Frame(frame)
    install_row.pack(fill="x", pady=(3, 12))
    install_var = tk.StringVar()
    ttk.Entry(install_row, textvariable=install_var, width=30).pack(side="left", fill="x", expand=True)

    def install_done(version: str, message: str, error: bool = False) -> None:
        install_button.configure(state="normal")
        status.set(message)
        if error:
            messagebox.showerror("安装失败", message)
        else:
            combo.configure(values=versions(root))
            chosen.set(version)

    def install_worker(version: str) -> None:
        try:
            result = install_game.install(root, version)
            window.after(0, install_done, version, f"已安装 {version} · Java {result['java']}")
        except Exception as error:
            window.after(0, install_done, version, str(error), True)

    def start_install() -> None:
        version = install_var.get().strip()
        if not version:
            messagebox.showerror("没有版本", "请输入官方游戏版本号")
            return
        install_button.configure(state="disabled")
        status.set(f"正在安装 {version}；下载进度可在终端查看……")
        threading.Thread(target=install_worker, args=(version,), daemon=True).start()

    install_button = ttk.Button(install_row, text="安装版本", command=start_install)
    install_button.pack(side="left", padx=(8, 0))
    row = ttk.Frame(frame)
    row.pack(fill="x")
    ttk.Label(row, text="离线玩家名").grid(row=0, column=0, sticky="w")
    ttk.Label(row, text="最大内存 (GiB)").grid(row=0, column=1, sticky="w", padx=(18, 0))
    player_var = tk.StringVar(value=player)
    memory_var = tk.StringVar(value=str(memory))
    ttk.Entry(row, textvariable=player_var, width=28).grid(row=1, column=0, sticky="ew", pady=(3, 12))
    ttk.Entry(row, textvariable=memory_var, width=12).grid(row=1, column=1, sticky="w", padx=(18, 0), pady=(3, 12))
    row.columnconfigure(0, weight=1)
    status = tk.StringVar(value=f"Java：{java or '按游戏版本自动选择'}")
    ttk.Label(frame, textvariable=status, wraplength=600).pack(anchor="w", pady=(3, 14))

    def finish(message: str, error: bool = False) -> None:
        status.set(message)
        button.configure(state="normal")
        if error:
            messagebox.showerror("启动失败", message)

    def run(version: str, selected_player: str, selected_memory: str, use_online: bool) -> None:
        try:
            cmd, where = command(root, version, selected_player, java, int(selected_memory), online=use_online)
            log_dir = root / ".pcl-linux" / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            log = log_dir / (version + ".log")
            with log.open("w", encoding="utf-8") as output:
                process = subprocess.Popen(cmd, cwd=where, stdout=output, stderr=subprocess.STDOUT)
                window.after(0, status.set, f"正在运行：PID {process.pid} · 日志 {log}")
                code = process.wait()
            window.after(0, finish, f"游戏已退出（代码 {code}）。日志：{log}", code != 0)
        except Exception as error:
            window.after(0, finish, str(error), True)

    def start() -> None:
        if not chosen.get():
            messagebox.showerror("没有版本", "请先选择游戏版本")
            return
        button.configure(state="disabled")
        status.set("正在检查并补齐 Linux 依赖……")
        threading.Thread(target=run, args=(chosen.get(), player_var.get(), memory_var.get(), online_var.get()), daemon=True).start()

    button = ttk.Button(frame, text="启动游戏", command=start)
    button.pack(anchor="w", pady=(8, 0))
    def close():
        login_cancel.set()
        window.destroy()

    window.protocol("WM_DELETE_WINDOW", close)
    window.mainloop()


if __name__ == "__main__":
    raise SystemExit(main())
