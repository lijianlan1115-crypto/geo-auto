#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性补丁：把 server.py 的平台配置归一化到五个固定平台 key。

作用：
- 前端即使传 custom_xxx，只要 name/url 像豆包、千问、DeepSeek、元宝、文心，就强制变成：
  doubao / qianwen / deepseek / yuanbao / wenxin
- 修复：任务生成后仍是 custom_xxx，导致不走专门适配、无法自动追问的问题。

用法：
  cd python_service
  python patch_server_platforms.py
  python server.py
"""
from pathlib import Path

path = Path(__file__).with_name("server.py")
text = path.read_text(encoding="utf-8")

old = '''def safe_platform_key(value, index=0):
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9_\\-]+", "_", text)
    text = text.strip("_")
    return text or f"custom_{index + 1}"


def configure_platforms(platforms):
    if not isinstance(platforms, list) or not platforms:
        return {"ok": False, "error": "平台列表为空"}

    new_platforms = {}
    used_keys = set()
    for index, item in enumerate(platforms):
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        base_key = safe_platform_key(item.get("key") or item.get("name"), index)
        key = base_key
        duplicate_index = 2
        while key in used_keys:
            key = f"{base_key}_{duplicate_index}"
            duplicate_index += 1
        used_keys.add(key)
        name = str(item.get("name") or key).strip()
        existing = PLATFORMS.get(key)
        new_platforms[key] = {
            "name": name,
            "column": existing.get("column") if existing else name,
            "url": url,
        }

    if not new_platforms:
        return {"ok": False, "error": "没有有效的平台 URL"}

    PLATFORMS.clear()
    PLATFORMS.update(new_platforms)
    ensure_dirs()
    seed_tasks()
    with connect_db() as conn:
        placeholders = ",".join("?" for _ in new_platforms)
        conn.execute(
            f"delete from tasks where platform not in ({placeholders})",
            tuple(new_platforms.keys()),
        )
    return {"ok": True, "platforms": runtime_platforms(), "stats": stats()}
'''

new = '''def canonical_platform_key(value="", name="", url=""):
    """把平台名称/URL 统一识别为五个固定 key，避免 custom_xxx 失去专门适配。"""
    text = f"{value or ''} {name or ''} {url or ''}".strip().lower()
    if re.search(r"doubao|豆包|www\\.doubao\\.com|doubao\\.com", text):
        return "doubao"
    if re.search(r"qianwen|千问|通义|tongyi\\.aliyun\\.com|aliyun\\.com/qianwen", text):
        return "qianwen"
    if re.search(r"deepseek|深度求索|chat\\.deepseek\\.com", text):
        return "deepseek"
    if re.search(r"yuanbao|元宝|腾讯元宝|yuanbao\\.tencent\\.com", text):
        return "yuanbao"
    if re.search(r"wenxin|文心|一言|yiyan|chat\\.baidu\\.com|baidu\\.com", text):
        return "wenxin"
    return ""


def safe_platform_key(value, index=0, name="", url=""):
    canonical = canonical_platform_key(value, name, url)
    if canonical:
        return canonical
    text = str(value or name or "").strip().lower()
    text = re.sub(r"[^a-z0-9_\\-]+", "_", text)
    text = text.strip("_")
    return text or f"custom_{index + 1}"


def configure_platforms(platforms):
    if not isinstance(platforms, list) or not platforms:
        return {"ok": False, "error": "平台列表为空"}

    old_platforms = dict(PLATFORMS)
    default_columns = {
        "doubao": "豆包",
        "qianwen": "千问",
        "deepseek": "DeepSeek",
        "yuanbao": "元宝",
        "wenxin": "文心一言",
    }
    default_names = {
        "doubao": "豆包",
        "qianwen": "千问",
        "deepseek": "DeepSeek",
        "yuanbao": "元宝",
        "wenxin": "文心一言",
    }

    new_platforms = {}
    used_keys = set()
    normalized = []
    for index, item in enumerate(platforms):
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        raw_key = str(item.get("key") or "").strip()
        name = str(item.get("name") or raw_key or f"平台{index + 1}").strip()
        base_key = safe_platform_key(raw_key or name, index, name=name, url=url)
        key = base_key
        duplicate_index = 2
        while key in used_keys:
            key = f"{base_key}_{duplicate_index}"
            duplicate_index += 1
        used_keys.add(key)

        existing = old_platforms.get(key) or PLATFORMS.get(key) or {}
        column = existing.get("column") or default_columns.get(key) or name
        new_platforms[key] = {
            "name": default_names.get(key) or name,
            "column": column,
            "url": url,
        }
        normalized.append({"input_key": raw_key, "input_name": name, "normalized_key": key, "url": url})

    if not new_platforms:
        return {"ok": False, "error": "没有有效的平台 URL"}

    PLATFORMS.clear()
    PLATFORMS.update(new_platforms)
    ensure_dirs()
    seed_tasks()
    with connect_db() as conn:
        placeholders = ",".join("?" for _ in new_platforms)
        conn.execute(
            f"delete from tasks where platform not in ({placeholders})",
            tuple(new_platforms.keys()),
        )
    return {"ok": True, "platforms": runtime_platforms(), "normalized": normalized, "stats": stats()}
'''

if old not in text:
    if "def canonical_platform_key" in text:
        print("✅ server.py 已经包含平台归一化补丁，无需重复修改。")
        raise SystemExit(0)
    raise SystemExit("❌ 没找到需要替换的代码块，server.py 可能已变化，请手动检查 configure_platforms。")

path.write_text(text.replace(old, new), encoding="utf-8")
print("✅ 已修改 server.py：平台会在 Python 服务端强制归一化为 doubao/qianwen/deepseek/yuanbao/wenxin。")
print("⚠️ 现在需要重启 python server.py，并在插件里保存配置、重置所有任务。")
