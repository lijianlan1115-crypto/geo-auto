from pathlib import Path
import os
import sys


if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = BASE_DIR.parent
LEGACY_PROJECT_DIR = BASE_DIR.parent.parent


def env_path(name, default):
    value = os.getenv(name, "").strip()
    return Path(value).expanduser().resolve() if value else Path(default).resolve()


# 打包后的 EXE 位于 python_service，所有输出都保存在交付包根目录。
# 源码模式兼容旧目录：geo数据/chrome+python插件/python_service，input.xlsx 位于 geo数据。
if getattr(sys, "frozen", False):
    _default_project_dir = REPO_DIR
else:
    _default_project_dir = LEGACY_PROJECT_DIR
    if not (_default_project_dir / "input.xlsx").exists() and (REPO_DIR / "input.xlsx").exists():
        _default_project_dir = REPO_DIR

PROJECT_DIR = env_path("GEO_PROJECT_DIR", _default_project_dir)
INPUT_EXCEL = env_path("GEO_INPUT_EXCEL", PROJECT_DIR / "input.xlsx")
OUTPUT_DIR = env_path("GEO_OUTPUT_DIR", PROJECT_DIR / "output")
SCREENSHOT_DIR = env_path("GEO_SCREENSHOT_DIR", OUTPUT_DIR / "screenshots")
RESULT_EXCEL = env_path("GEO_RESULT_EXCEL", OUTPUT_DIR / "result.xlsx")
TEMP_ANSWERS_EXCEL = env_path("GEO_TEMP_ANSWERS_EXCEL", OUTPUT_DIR / "ai返回内容临时表.xlsx")
DB_PATH = env_path("GEO_DB_PATH", OUTPUT_DIR / "progress.sqlite")
AI_JUDGE_CONFIG_PATH = env_path("GEO_AI_JUDGE_CONFIG_PATH", OUTPUT_DIR / "ai_judge_config.json")

HOST = os.getenv("GEO_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.getenv("GEO_PORT", "8765") or "8765")

# Target keywords come from each Excel row or the Chrome extension settings.
# Keep the service fallback empty so a missing configuration cannot run silently.
KEYWORDS = []
KEYWORD = ""
MAX_FOLLOWUPS = int(os.getenv("GEO_MAX_FOLLOWUPS", "3") or "3")
CONCURRENCY = int(os.getenv("GEO_CONCURRENCY", "3") or "3")

# Internal answer judge. This is only used by the local Python service to decide
# whether a captured platform answer refers to the target keyword; it is never
# sent to the tested AI platforms as part of the user's question or follow-up.
AI_JUDGE_ENABLED = os.getenv("GEO_AI_JUDGE_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
AI_JUDGE_API_URL = os.getenv("GEO_AI_JUDGE_API_URL", "").strip()
AI_JUDGE_API_KEY = os.getenv("GEO_AI_JUDGE_API_KEY", "").strip()
AI_JUDGE_MODEL = os.getenv("GEO_AI_JUDGE_MODEL", "").strip()
AI_JUDGE_TIMEOUT_SECONDS = int(os.getenv("GEO_AI_JUDGE_TIMEOUT_SECONDS", "20") or "20")

ANSWER_POLL_INTERVAL = float(os.getenv("GEO_ANSWER_POLL_INTERVAL", "0.8") or "0.8")
ANSWER_STABLE_SECONDS = float(os.getenv("GEO_ANSWER_STABLE_SECONDS", "6") or "6")
ANSWER_KEYWORD_STABLE_SECONDS = float(os.getenv("GEO_ANSWER_KEYWORD_STABLE_SECONDS", "6") or "6")
ANSWER_FINAL_SETTLE_SECONDS = float(os.getenv("GEO_ANSWER_FINAL_SETTLE_SECONDS", "8") or "8")
ANSWER_MIN_CHARS = int(os.getenv("GEO_ANSWER_MIN_CHARS", "40") or "40")
ANSWER_TIMEOUT_SECONDS = int(os.getenv("GEO_ANSWER_TIMEOUT_SECONDS", "90") or "90")

QUESTION_HEADERS = ["问题", "question", "题目"]
ID_HEADERS = ["id", "ID", "序号"]
KEYWORD_HEADERS = ["关键词", "目标关键词", "keywords", "keyword"]
PLATFORM_COLUMN_ALIASES = {
    "qianwen": ["千问", "干问"],
}

PLATFORMS = {
    "doubao": {
        "name": "豆包",
        "column": "豆包",
        "url": "https://www.doubao.com/chat/",
    },
    "qianwen": {
        "name": "千问",
        "column": "千问",
        "url": "https://tongyi.aliyun.com/qianwen/",
    },
    "deepseek": {
        "name": "DeepSeek",
        "column": "deepseek",
        "url": "https://chat.deepseek.com/",
    },
    "yuanbao": {
        "name": "元宝",
        "column": "元宝",
        "url": "https://yuanbao.tencent.com/chat/",
    },
    "wenxin": {
        "name": "文心一言",
        "column": "文心一言",
        "url": "https://chat.baidu.com/?enter_type=yiyan_site",
    },
}
