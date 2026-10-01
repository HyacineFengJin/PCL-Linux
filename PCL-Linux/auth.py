"""Microsoft public-client device login and Minecraft session exchange.

Requires this application's own registered, Minecraft-approved public client ID.
No client secret or borrowed launcher client ID is shipped.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0"
SCOPE = "XboxLive.signin offline_access"
MINECRAFT = "https://api.minecraftservices.com"


class AuthError(ValueError):
    pass


class ResponseError(AuthError):
    def __init__(self, status, data):
        self.status = status
        self.data = data
        code = data.get("error", data.get("XErr", "request_failed"))
        # Never echo response bodies: provider diagnostics may include credentials.
        super().__init__(f"登录服务返回 HTTP {status}（{code}）")


def request(url: str, data=None, *, form=False, token=None):
    headers = {"Accept": "application/json", "User-Agent": "PCL-Linux/0.2"}
    body = None
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        body = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error)
        except (ValueError, OSError):
            detail = {}
        raise ResponseError(error.code, detail) from None


def account_path(root: Path) -> Path:
    return root / ".pcl-linux" / "accounts" / "account.json"


def save(root: Path, account: dict):
    path = account_path(root)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, name = tempfile.mkstemp(prefix=".account-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(account, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def load(root: Path) -> dict:
    path = account_path(root)
    if not path.exists():
        raise AuthError("尚未登录微软账号，请先登录")
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise AuthError("账号缓存的所有者或文件类型不安全，请退出登录后重试")
    os.chmod(path, 0o600)
    return json.loads(path.read_text(encoding="utf-8"))


def account_info(root: Path):
    try:
        account = load(root)
        return {"name": account["name"], "uuid": account["uuid"]}
    except (OSError, ValueError, KeyError):
        return None


def logout(root: Path):
    account_path(root).unlink(missing_ok=True)


def exchange(ms: dict, client_id: str) -> dict:
    xbox = request("https://user.auth.xboxlive.com/user/authenticate", {
        "Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": "d=" + ms["access_token"]},
        "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT",
    })
    try:
        xsts = request("https://xsts.auth.xboxlive.com/xsts/authorize", {
            "Properties": {"SandboxId": "RETAIL", "UserTokens": [xbox["Token"]]},
            "RelyingParty": "rp://api.minecraftservices.com/", "TokenType": "JWT",
        })
    except ResponseError as error:
        if error.data.get("XErr") == 2148916233:
            raise AuthError("此微软账号尚未建立 Xbox 档案，请先访问 xbox.com 完成设置") from None
        if error.data.get("XErr") in (2148916235, 2148916236, 2148916237, 2148916238):
            raise AuthError("Xbox 家庭、年龄或地区限制阻止登录，请在微软账号设置中处理") from None
        raise
    claims = xsts["DisplayClaims"]["xui"][0]
    mc = request(MINECRAFT + "/authentication/login_with_xbox", {
        "identityToken": "XBL3.0 x=" + claims["uhs"] + ";" + xsts["Token"],
    })
    token = mc["access_token"]
    # Check the Java entitlement and profile before storing credentials.
    entitlements = request(MINECRAFT + "/entitlements/mcstore", token=token)
    if not any(item.get("name") in ("product_minecraft", "game_minecraft") for item in entitlements.get("items", [])):
        raise AuthError("账号未返回有效的 Minecraft Java 许可，请确认购买或 Game Pass 状态")
    try:
        profile = request(MINECRAFT + "/minecraft/profile", token=token)
    except ResponseError as error:
        if error.status == 404:
            raise AuthError("账号没有可用的 Minecraft Java 档案，请确认已购买或有有效 Game Pass，并已设置游戏名") from None
        raise
    if not re.fullmatch(r"[0-9a-fA-F]{32}", profile.get("id", "")) or not profile.get("name"):
        raise AuthError("Minecraft 服务返回了无效的玩家档案")
    return {
        "name": profile["name"], "uuid": profile["id"], "access_token": token,
        "expires_at": time.time() + int(mc["expires_in"]), "client_id": client_id,
        "refresh_token": ms.get("refresh_token", ""), "xuid": claims.get("xid", ""),
        "entitlements": [item.get("name") for item in entitlements.get("items", [])],
    }


def login(root: Path, client_id: str, on_device, cancel: threading.Event | None = None):
    if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", client_id or ""):
        raise AuthError("需要此项目自己的微软公共客户端 ID；请配置 PCL_LINUX_CLIENT_ID。详见 AUTHENTICATION.md")
    cancel = cancel or threading.Event()
    device = request(AUTHORITY + "/devicecode", {"client_id": client_id, "scope": SCOPE}, form=True)
    on_device(device["verification_uri"], device["user_code"])
    deadline = time.monotonic() + int(device["expires_in"])
    interval = max(1, int(device.get("interval", 5)))
    while time.monotonic() < deadline:
        if cancel.wait(interval):
            raise AuthError("登录已取消")
        try:
            ms = request(AUTHORITY + "/token", {
                "client_id": client_id, "device_code": device["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }, form=True)
        except ResponseError as error:
            code = error.data.get("error")
            if code == "authorization_pending":
                continue
            if code == "slow_down":
                interval += 5
                continue
            raise
        account = exchange(ms, client_id)
        if cancel.is_set():
            raise AuthError("登录已取消")
        save(root, account)
        return {"name": account["name"], "uuid": account["uuid"]}
    raise AuthError("登录验证码已过期，请重新登录")


def session(root: Path) -> dict:
    account = load(root)
    if account.get("expires_at", 0) <= time.time() + 120:
        if not account.get("refresh_token"):
            raise AuthError("登录已过期，请重新登录")
        ms = request(AUTHORITY + "/token", {
            "client_id": account["client_id"], "grant_type": "refresh_token",
            "refresh_token": account["refresh_token"], "scope": SCOPE,
        }, form=True)
        ms.setdefault("refresh_token", account["refresh_token"])
        account = exchange(ms, account["client_id"])
        save(root, account)
    return account
