from pathlib import Path
import os


BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent.parent

INPUT_EXCEL = PROJECT_DIR / "input.xlsx"
OUTPUT_DIR = PROJECT_DIR / "output"
SCREENSHOT_DIR = OUTPUT_DIR / "screenshots"
RESULT_EXCEL = OUTPUT_DIR / "result.xlsx"
TEMP_ANSWERS_EXCEL = OUTPUT_DIR / "ai返回内容临时表.xlsx"
DB_PATH = OUTPUT_DIR / "progress.sqlite"
AI_JUDGE_CONFIG_PATH = OUTPUT_DIR / "ai_judge_config.json"

HOST = "127.0.0.1"
PORT = 8765

KEYWORDS = ["贵州商学院", "贵阳商学院"]
KEYWORD = "贵阳商学院"
MAX_FOLLOWUPS = 3
CONCURRENCY = 3

# Internal answer judge. This is only used by the local Python service to decide
# whether a captured platform answer refers to the target keyword; it is never
# sent to the tested AI platforms as part of the user's question or follow-up.
AI_JUDGE_ENABLED = os.getenv("GEO_AI_JUDGE_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
AI_JUDGE_API_URL = os.getenv("GEO_AI_JUDGE_API_URL", "").strip()
AI_JUDGE_API_KEY = os.getenv("GEO_AI_JUDGE_API_KEY", "").strip()
AI_JUDGE_MODEL = os.getenv("GEO_AI_JUDGE_MODEL", "").strip()
AI_JUDGE_TIMEOUT_SECONDS = int(os.getenv("GEO_AI_JUDGE_TIMEOUT_SECONDS", "20") or "20")

ANSWER_POLL_INTERVAL = 0.8
ANSWER_STABLE_SECONDS = 3
ANSWER_KEYWORD_STABLE_SECONDS = 1.5
ANSWER_TIMEOUT_SECONDS = 90

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
