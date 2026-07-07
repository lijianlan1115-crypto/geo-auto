from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent.parent

INPUT_EXCEL = PROJECT_DIR / "input.xlsx"
OUTPUT_DIR = PROJECT_DIR / "output"
SCREENSHOT_DIR = OUTPUT_DIR / "screenshots"
RESULT_EXCEL = OUTPUT_DIR / "result.xlsx"
DB_PATH = OUTPUT_DIR / "progress.sqlite"

HOST = "127.0.0.1"
PORT = 8765

KEYWORDS = ["贵阳商学院"]
KEYWORD = KEYWORDS[0]
MAX_FOLLOWUPS = 5
CONCURRENCY = 3

ANSWER_POLL_INTERVAL = 2
ANSWER_STABLE_SECONDS = 10
ANSWER_TIMEOUT_SECONDS = 180

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
