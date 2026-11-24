"""模型下载：默认走国内镜像直连，失败回退官方源，最后才用本机代理。

国内网络实测规律：
- 国内镜像（hf-mirror.com、ModelScope、清华 PyPI）直连通常比走代理快，代理反而绕远路；
- 官方源（huggingface.co、storage.googleapis.com）直连经常超时，需要代理才稳定。

所以尝试顺序固定为：镜像直连 → 官方直连 → 镜像+代理 → 官方+代理。

环境变量：
    DANCEMATE_PROXY       代理地址，如 http://127.0.0.1:7890；未设置时读
                          HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，再探测本机 7890 端口
    DANCEMATE_NO_PROXY=1  只直连，完全不做代理回退
    DANCEMATE_HF_ENDPOINT HuggingFace 镜像，默认 https://hf-mirror.com
"""

from __future__ import annotations

import contextlib
import logging
import os
import socket
import sys
import urllib.request
from pathlib import Path
from typing import Iterator, Optional, Sequence, Union

logger = logging.getLogger("dancemate.download")

HF_MIRROR = os.getenv("DANCEMATE_HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
HF_OFFICIAL = "https://huggingface.co"
DEFAULT_PROXY = "http://127.0.0.1:7890"
# GitHub 文件国内直连常被墙，镜像前缀支持 github.com / raw.githubusercontent.com
GITHUB_MIRROR = "https://gh-proxy.com/"

# 未显式配置时，让 huggingface_hub / faster-whisper 默认走镜像（须在 import 前设置）
os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
# hf-mirror 不支持 Xet 存储，关掉可避免下载卡住
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

_PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
_NO_PROXY_KEYS = ("NO_PROXY", "no_proxy")
_UNSET = object()
_proxy_cache: object = _UNSET

# 一份模型目录里必须有的文件（缺一个就不算下载完成）
WHISPER_ALLOW_PATTERNS = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)


class DownloadError(RuntimeError):
    """所有下载路由都失败。"""


def _port_open(host: str, port: int, timeout: float = 0.25) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def proxy_url(refresh: bool = False) -> Optional[str]:
    """取代理地址：DANCEMATE_PROXY > 环境变量 > 本机 7890 探测；取不到返回 None。"""
    global _proxy_cache
    if not refresh and _proxy_cache is not _UNSET:
        return _proxy_cache  # type: ignore[return-value]

    resolved: Optional[str] = None
    if os.getenv("DANCEMATE_NO_PROXY", "").strip() != "1":
        explicit = os.getenv("DANCEMATE_PROXY", "").strip()
        if explicit:
            resolved = explicit if "://" in explicit else f"http://{explicit}"
        else:
            for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
                value = os.getenv(key, "").strip()
                if value:
                    resolved = value if "://" in value else f"http://{value}"
                    break
            else:
                if _port_open("127.0.0.1", 7890):
                    resolved = DEFAULT_PROXY
    _proxy_cache = resolved
    return resolved


def _opener(proxy: Optional[str]) -> urllib.request.OpenerDirector:
    if proxy:
        handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    else:
        # 空字典 = 显式绕过系统代理，确保「直连」真的是直连
        handler = urllib.request.ProxyHandler({})
    return urllib.request.build_opener(handler)


def url_candidates(url: str) -> list[tuple[str, str]]:
    """给一个官方 URL 补上镜像候选（GitHub 文件走 gh-proxy），镜像在前。"""
    if "raw.githubusercontent.com" in url or url.startswith("https://github.com/"):
        return [("GitHub 镜像", GITHUB_MIRROR + url), ("官方源", url)]
    return [("官方源", url)]


def _fetch_once(url: str, target: Path, proxy: Optional[str], timeout: float) -> int:
    tmp = target.with_suffix(target.suffix + ".tmp")
    request = urllib.request.Request(url, headers={"User-Agent": "DanceMate/1.0"})
    try:
        with _opener(proxy).open(request, timeout=timeout) as response, open(tmp, "wb") as out:
            total = 0
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                total += len(chunk)
        if total == 0:
            raise DownloadError("响应为 0 字节")
        tmp.replace(target)
        return total
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def fetch_file(
    sources: Union[str, Sequence[tuple[str, str]]],
    target: Union[str, Path],
    *,
    timeout: float = 180,
    hint: str = "",
) -> Path:
    """下载单个文件到 target，已存在则直接返回。

    sources：单个 URL，或 [(说明, url), ...] 候选列表（按优先级）。
    尝试顺序：候选直连；再对候选逐个走代理。
    """
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return target

    candidates = [("官方源", sources)] if isinstance(sources, str) else list(sources)
    proxy = proxy_url()
    routes: list[tuple[str, Optional[str], tuple[str, str]]] = [
        ("直连", None, item) for item in candidates
    ]
    if proxy:
        routes += [(f"代理 {proxy}", proxy, item) for item in candidates]

    errors: list[str] = []
    for route, route_proxy, (label, url) in routes:
        try:
            size = _fetch_once(url, target, route_proxy, timeout)
        except Exception as exc:  # noqa: BLE001 - 逐条路由失败都只是换下一条
            errors.append(f"{route}/{label}: {exc}")
            logger.debug("下载失败 %s %s", route, url)
            continue
        size_text = f"{size / 1048576:.1f}MB" if size >= 1048576 else f"{max(size // 1024, 1)}KB"
        logger.info("%s（%s / %s）：%s -> %s", hint or target.name, route, label, size_text, target)
        return target

    detail = "；".join(errors)
    raise DownloadError(f"{hint or target.name} 下载失败：{detail}")


@contextlib.contextmanager
def _hf_env(endpoint: str, proxy: Optional[str]) -> Iterator[str]:
    """临时把 HF_ENDPOINT / 代理写入环境变量，退出时还原。"""
    snapshot = {key: os.environ.get(key) for key in _PROXY_KEYS + _NO_PROXY_KEYS + ("HF_ENDPOINT",)}
    try:
        os.environ["HF_ENDPOINT"] = endpoint
        if proxy:
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                os.environ[key] = proxy
            for key in _NO_PROXY_KEYS:
                os.environ.pop(key, None)
        else:
            for key in _PROXY_KEYS:
                os.environ.pop(key, None)
        yield endpoint
    finally:
        for key, value in snapshot.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        _patch_hf_endpoint(snapshot.get("HF_ENDPOINT") or HF_MIRROR)


def _patch_hf_endpoint(endpoint: str) -> None:
    """huggingface_hub 在 import 时固化了 ENDPOINT，切镜像要同步改模块属性。"""
    modules = [sys.modules.get("huggingface_hub"), sys.modules.get("huggingface_hub.constants")]
    modules.append(sys.modules.get("huggingface_hub.file_download"))
    for module in modules:
        if module is None:
            continue
        for attr in ("ENDPOINT", "HF_ENDPOINT"):
            if hasattr(module, attr):
                setattr(module, attr, endpoint)


def _snapshot_once(
    repo_id: str,
    target_dir: Path,
    endpoint: str,
    proxy: Optional[str],
    allow_patterns: Optional[Sequence[str]],
) -> None:
    from huggingface_hub import snapshot_download  # 延迟导入：语音功能可选装

    with _hf_env(endpoint, proxy):
        _patch_hf_endpoint(endpoint)
        kwargs = {
            "repo_id": repo_id,
            "local_dir": str(target_dir),
            "allow_patterns": list(allow_patterns) if allow_patterns else None,
        }
        try:
            snapshot_download(endpoint=endpoint, **kwargs)
        except TypeError:
            # 旧版 huggingface_hub 没有 endpoint 参数，只能靠环境变量
            snapshot_download(**kwargs)


def hf_snapshot(
    repo_id: str,
    target_dir: Union[str, Path],
    *,
    allow_patterns: Optional[Sequence[str]] = None,
    hint: str = "",
) -> Path:
    """把 HuggingFace 仓库拉到本地目录：hf-mirror 直连 → 官方直连 → 镜像/官方 + 代理。"""
    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    if (target_dir / "model.bin").exists() and "whisper" in repo_id.lower():
        return target_dir

    proxy = proxy_url()
    routes: list[tuple[str, str, Optional[str]]] = [
        ("hf-mirror 直连", HF_MIRROR, None),
        ("官方源直连", HF_OFFICIAL, None),
    ]
    if proxy:
        routes += [
            (f"hf-mirror + 代理 {proxy}", HF_MIRROR, proxy),
            (f"官方源 + 代理 {proxy}", HF_OFFICIAL, proxy),
        ]

    errors: list[str] = []
    for route, endpoint, route_proxy in routes:
        try:
            _snapshot_once(repo_id, target_dir, endpoint, route_proxy, allow_patterns)
        except Exception as exc:  # noqa: BLE001 - 换下一条路由
            errors.append(f"{route}: {exc}")
            logger.debug("拉取 %s 失败（%s）", repo_id, route)
            continue
        logger.info("%s（%s）：%s -> %s", hint or repo_id, route, repo_id, target_dir)
        return target_dir

    raise DownloadError(f"{hint or repo_id} 下载失败：{'；'.join(errors)}")


def whisper_repo_id(model: str) -> str:
    """'whisper-base' / 'base' -> Systran/faster-whisper-base；含 / 视为完整 repo。"""
    if "/" in model:
        return model
    size = model[len("whisper-"):] if model.startswith("whisper-") else model
    return f"Systran/faster-whisper-{size}"


def ensure_whisper_dir(model: str, models_root: Union[str, Path]) -> Path:
    """下载 faster-whisper 的 CTranslate2 模型到 models_root/<model>，可直接本地加载。"""
    target = Path(models_root) / model
    if (target / "model.bin").exists():
        return target
    return hf_snapshot(
        whisper_repo_id(model),
        target,
        allow_patterns=WHISPER_ALLOW_PATTERNS,
        hint=f"Whisper 模型 {model}",
    )
