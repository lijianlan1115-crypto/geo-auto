import base64
import json
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from config import (
    ANSWER_POLL_INTERVAL,
    ANSWER_STABLE_SECONDS,
    ANSWER_TIMEOUT_SECONDS,
    CONCURRENCY,
    DB_PATH,
    HOST,
    ID_HEADERS,
    INPUT_EXCEL,
    KEYWORD,
    KEYWORD_HEADERS,
    KEYWORDS,
    MAX_FOLLOWUPS,
    OUTPUT_DIR,
    PLATFORM_COLUMN_ALIASES,
    PLATFORMS,
    PORT,
    QUESTION_HEADERS,
    RESULT_EXCEL,
    SCREENSHOT_DIR,
)

try:
    from openpyxl import load_workbook
    from openpyxl.drawing.image import Image as ExcelImage
except ImportError as exc:
    raise SystemExit("缺少 openpyxl，请先安装：pip install openpyxl") from exc


lock = threading.Lock()


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure_dirs():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    for platform in PLATFORMS:
        (SCREENSHOT_DIR / platform).mkdir(parents=True, exist_ok=True)


def connect_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    ensure_dirs()
    with connect_db() as conn:
        conn.execute(
            """
            create table if not exists tasks (
                task_id text primary key,
                row_number integer not null,
                row_id text,
                question text not null,
                platform text not null,
                status text not null default 'pending',
                matched integer,
                followup_count integer default 0,
                screenshot_path text,
                answer_text text,
                error text,
                created_at text not null,
                updated_at text not null
            )
            """
        )
        conn.execute("create index if not exists idx_tasks_status on tasks(status)")


def read_headers(sheet):
    headers = {}
    for cell in sheet[1]:
        if cell.value is not None:
            headers[str(cell.value).strip()] = cell.column
    return headers


def find_column(headers, names):
    for name in names:
        if name in headers:
            return headers[name]
    return None


def find_platform_column(headers, platform):
    names = [PLATFORMS[platform]["column"]]
    names.extend(PLATFORM_COLUMN_ALIASES.get(platform, []))
    return find_column(headers, names)


def split_keywords(value):
    if value is None:
        return list(KEYWORDS)
    text = str(value).strip()
    if not text:
        return list(KEYWORDS)
    parts = re.split(r"[\n,，、;；|/]+|\s+or\s+|\s+OR\s+", text)
    keywords = [part.strip() for part in parts if part and part.strip()]
    return keywords or list(KEYWORDS)


def prepare_workbook():
    if not INPUT_EXCEL.exists():
        raise FileNotFoundError(f"找不到输入 Excel：{INPUT_EXCEL}")

    if not RESULT_EXCEL.exists():
        shutil.copy2(INPUT_EXCEL, RESULT_EXCEL)

    wb = load_workbook(RESULT_EXCEL)
    ws = wb.active
    headers = read_headers(ws)

    question_col = find_column(headers, QUESTION_HEADERS)
    if question_col is None:
        detected = ", ".join(headers.keys()) or "空表头"
        raise RuntimeError(
            "Excel 第一行找不到问题列。"
            f"支持列名：{QUESTION_HEADERS}。"
            f"当前检测到的表头：{detected}。"
            "请使用包含“id”和“问题”列的原始问题表作为 input.xlsx。"
        )

    id_col = find_column(headers, ID_HEADERS)
    keyword_col = find_column(headers, KEYWORD_HEADERS)

    max_col = ws.max_column
    for platform, item in PLATFORMS.items():
        column_name = item["column"]
        existing_col = find_platform_column(headers, platform)
        if existing_col is None:
            max_col += 1
            ws.cell(row=1, column=max_col, value=column_name)
            headers[column_name] = max_col
        elif column_name not in headers:
            headers[column_name] = existing_col

        status_name = f"{column_name}_状态"
        if status_name not in headers:
            max_col += 1
            ws.cell(row=1, column=max_col, value=status_name)
            headers[status_name] = max_col

        followup_name = f"{column_name}_追问次数"
        if followup_name not in headers:
            max_col += 1
            ws.cell(row=1, column=max_col, value=followup_name)
            headers[followup_name] = max_col

    wb.save(RESULT_EXCEL)
    return question_col, id_col, keyword_col


def seed_tasks():
    try:
        question_col, id_col, keyword_col = prepare_workbook()
    except Exception as exc:
        print(f"任务初始化跳过：{exc}")
        print("服务会继续启动，方便先测试 Chrome 插件连接；换成包含“问题”列的 Excel 后再重启即可生成任务。")
        return 0

    wb = load_workbook(RESULT_EXCEL, read_only=True)
    ws = wb.active

    created = 0
    with connect_db() as conn:
        for row_number in range(2, ws.max_row + 1):
            question = ws.cell(row=row_number, column=question_col).value
            if question is None or not str(question).strip():
                continue

            row_id = ws.cell(row=row_number, column=id_col).value if id_col else row_number
            row_keywords = split_keywords(ws.cell(row=row_number, column=keyword_col).value if keyword_col else None)
            for platform in PLATFORMS:
                task_id = f"{row_number}:{platform}"
                exists = conn.execute(
                    "select 1 from tasks where task_id = ?", (task_id,)
                ).fetchone()
                if exists:
                    continue

                conn.execute(
                    """
                    insert into tasks (
                        task_id, row_number, row_id, question, platform, status,
                        answer_text, created_at, updated_at
                    )
                    values (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                    """,
                    (
                        task_id,
                        row_number,
                        str(row_id),
                        str(question).strip(),
                        platform,
                        json.dumps({"keywords": row_keywords}, ensure_ascii=False),
                        now(),
                        now(),
                    ),
                )
                created += 1
    return created


def get_next_task():
    with lock, connect_db() as conn:
        task = conn.execute(
            """
            select * from tasks
            where status = 'pending'
            order by row_number asc, platform asc
            limit 1
            """
        ).fetchone()

        if not task:
            return None

        conn.execute(
            "update tasks set status = 'running', updated_at = ? where task_id = ?",
            (now(), task["task_id"]),
        )

    platform = PLATFORMS[task["platform"]]
    keywords = list(KEYWORDS)
    try:
        meta = json.loads(task["answer_text"] or "{}")
        keywords = meta.get("keywords") or keywords
    except Exception:
        pass
    return {
        "task_id": task["task_id"],
        "row_number": task["row_number"],
        "row_id": task["row_id"],
        "question": task["question"],
        "keyword": keywords[0],
        "keywords": keywords,
        "platform": task["platform"],
        "platform_name": platform["name"],
        "platform_url": platform["url"],
        "max_followups": MAX_FOLLOWUPS,
        "answer_poll_interval": ANSWER_POLL_INTERVAL,
        "answer_stable_seconds": ANSWER_STABLE_SECONDS,
        "answer_timeout_seconds": ANSWER_TIMEOUT_SECONDS,
    }


def image_from_data_url(data_url, platform, task_id, matched):
    if not data_url:
        return None

    if "," in data_url:
        _, raw = data_url.split(",", 1)
    else:
        raw = data_url

    suffix = "hit" if matched else "miss"
    safe_task_id = task_id.replace(":", "_")
    path = SCREENSHOT_DIR / platform / f"{safe_task_id}_{suffix}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(raw))
    return path


def save_test_screenshot(payload):
    data_url = payload.get("screenshot_data_url")
    if not data_url:
        raise ValueError("缺少 screenshot_data_url")

    if "," in data_url:
        _, raw = data_url.split(",", 1)
    else:
        raw = data_url

    test_dir = SCREENSHOT_DIR / "test"
    test_dir.mkdir(parents=True, exist_ok=True)
    keywords = payload.get("keywords") or split_keywords(payload.get("keyword") or KEYWORD)
    safe_keyword = "_".join("".join(ch for ch in item if ch.isalnum() or ch in ("-", "_")) for item in keywords)
    safe_keyword = safe_keyword[:80] or "keyword"
    path = test_dir / f"test_{safe_keyword}_{int(time.time())}.png"
    path.write_bytes(base64.b64decode(raw))
    return {"ok": True, "screenshot_path": str(path)}


def get_test_keywords():
    if not INPUT_EXCEL.exists():
        return {
            "ok": True,
            "source": "default",
            "keywords": list(KEYWORDS),
            "message": f"找不到输入 Excel：{INPUT_EXCEL}",
        }

    wb = load_workbook(INPUT_EXCEL, read_only=True)
    ws = wb.active
    headers = read_headers(ws)
    keyword_col = find_column(headers, KEYWORD_HEADERS)
    question_col = find_column(headers, QUESTION_HEADERS)

    if keyword_col is None:
        return {
            "ok": True,
            "source": "default",
            "keywords": list(KEYWORDS),
            "message": f"Excel 没有关键词列，支持列名：{KEYWORD_HEADERS}",
        }

    for row_number in range(2, ws.max_row + 1):
        keywords = split_keywords(ws.cell(row=row_number, column=keyword_col).value)
        question = ws.cell(row=row_number, column=question_col).value if question_col else None
        if keywords:
            return {
                "ok": True,
                "source": "excel",
                "row_number": row_number,
                "question": question,
                "keywords": keywords,
            }

    return {
        "ok": True,
        "source": "default",
        "keywords": list(KEYWORDS),
        "message": "Excel 关键词列为空，使用默认关键词",
    }


def col_letter(ws, column_index):
    return ws.cell(row=1, column=column_index).column_letter


def image_anchor_cell(image):
    anchor = getattr(image, "anchor", None)
    if isinstance(anchor, str):
        return anchor

    marker = getattr(anchor, "_from", None)
    if marker is None:
        return None

    row = int(marker.row) + 1
    col = int(marker.col) + 1
    return f"{col_letter_from_index(col)}{row}"


def col_letter_from_index(column_index):
    letters = ""
    while column_index:
        column_index, remainder = divmod(column_index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def remove_images_at_cell(ws, cell_ref):
    kept = []
    for image in getattr(ws, "_images", []):
        if image_anchor_cell(image) != cell_ref:
            kept.append(image)
    ws._images = kept


def write_result_to_excel(result, screenshot_path):
    wb = load_workbook(RESULT_EXCEL)
    ws = wb.active
    headers = read_headers(ws)

    platform = result["platform"]
    platform_config = PLATFORMS[platform]
    image_col = headers[platform_config["column"]]
    status_col = headers[f"{platform_config['column']}_状态"]
    followup_col = headers[f"{platform_config['column']}_追问次数"]
    row_number = int(result["row_number"])

    matched = bool(result.get("matched"))
    matched_keywords = result.get("matched_keywords") or []
    if matched and matched_keywords:
        status_text = f"命中：{'，'.join(matched_keywords)}"
    else:
        status_text = "命中" if matched else "未命中"
    ws.cell(row=row_number, column=status_col, value=status_text)
    ws.cell(row=row_number, column=followup_col, value=int(result.get("followup_count", 0)))

    if screenshot_path and Path(screenshot_path).exists():
        image_cell = f"{col_letter(ws, image_col)}{row_number}"
        remove_images_at_cell(ws, image_cell)

        img = ExcelImage(str(screenshot_path))
        img.width = 260
        img.height = 150
        img.anchor = image_cell
        img.object_position = 1
        ws.add_image(img)

        ws.row_dimensions[row_number].height = max(ws.row_dimensions[row_number].height or 0, 125)
        ws.column_dimensions[col_letter(ws, image_col)].width = max(
            ws.column_dimensions[col_letter(ws, image_col)].width or 0, 38
        )

    wb.save(RESULT_EXCEL)


def submit_result(payload):
    required = ["task_id", "row_number", "platform"]
    missing = [key for key in required if key not in payload]
    if missing:
        raise ValueError(f"缺少字段：{missing}")

    matched = bool(payload.get("matched"))
    screenshot_path = image_from_data_url(
        payload.get("screenshot_data_url"),
        payload["platform"],
        payload["task_id"],
        matched,
    )

    with lock:
        if screenshot_path:
            write_result_to_excel(payload, screenshot_path)

        with connect_db() as conn:
            conn.execute(
                """
                update tasks
                set status = 'done',
                    matched = ?,
                    followup_count = ?,
                    screenshot_path = ?,
                    answer_text = ?,
                    error = ?,
                    updated_at = ?
                where task_id = ?
                """,
                (
                    1 if matched else 0,
                    int(payload.get("followup_count", 0)),
                    str(screenshot_path) if screenshot_path else None,
                    payload.get("answer_text", "")[:20000],
                    payload.get("error"),
                    now(),
                    payload["task_id"],
                ),
            )

    return {"ok": True, "screenshot_path": str(screenshot_path) if screenshot_path else None}


def mark_failed(payload):
    task_id = payload.get("task_id")
    if not task_id:
        raise ValueError("缺少 task_id")

    with connect_db() as conn:
        conn.execute(
            """
            update tasks
            set status = 'failed', error = ?, updated_at = ?
            where task_id = ?
            """,
            (payload.get("error", "unknown error"), now(), task_id),
        )
    return {"ok": True}


def stats():
    with connect_db() as conn:
        rows = conn.execute(
            "select status, count(*) as count from tasks group by status order by status"
        ).fetchall()
        return {row["status"]: row["count"] for row in rows}


def reset_failed_tasks():
    with connect_db() as conn:
        cursor = conn.execute(
            """
            update tasks
            set status = 'pending',
                matched = null,
                followup_count = 0,
                screenshot_path = null,
                error = null,
                updated_at = ?
            where status in ('failed', 'running')
            """,
            (now(),),
        )
        reset_count = cursor.rowcount
    return {"ok": True, "reset_count": reset_count, "stats": stats()}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _send_html(self, html_text):
        body = html_text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "keyword": KEYWORD, "keywords": KEYWORDS, "stats": stats()})
        elif path == "/config":
            self._send(
                200,
                {
                    "keyword": KEYWORD,
                    "keywords": KEYWORDS,
                    "max_followups": MAX_FOLLOWUPS,
                    "concurrency": CONCURRENCY,
                    "platforms": PLATFORMS,
                    "answer_poll_interval": ANSWER_POLL_INTERVAL,
                    "answer_stable_seconds": ANSWER_STABLE_SECONDS,
                    "answer_timeout_seconds": ANSWER_TIMEOUT_SECONDS,
                },
            )
        elif path == "/next-task":
            task = get_next_task()
            self._send(200, {"ok": True, "task": task})
        elif path == "/test-keywords":
            self._send(200, get_test_keywords())
        elif path == "/test-page":
            self._send_html(
                """
                <!doctype html>
                <html lang="zh-CN">
                  <head>
                    <meta charset="utf-8">
                    <title>GEO截图测试页</title>
                    <style>
                      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 48px 80px; line-height: 1.8; }
                      main { max-width: 880px; margin: auto; }
                      h1 { font-size: 28px; }
                      p { font-size: 18px; }
                      .answer { border: 1px solid #dadce0; border-radius: 10px; padding: 24px; background: #fff; }
                    </style>
                  </head>
                  <body>
                    <main>
                      <h1>GEO截图测试页</h1>
                      <div class="answer">
                        <p>这是一个用于测试插件截图和关键词标注的页面。</p>
                        <p>示例回答：如果问题涉及贵州地区的商科、管理类、应用型本科院校，可以重点关注贵阳商学院，并结合专业方向、学费和就业城市进行比较。</p>
                        <p>点击左侧 GEO 小圆球，输入目标关键词后点击“测试截图”。</p>
                      </div>
                    </main>
                  </body>
                </html>
                """
            )
        elif path == "/mock-platform":
            self._send_html(
                """
                <!doctype html>
                <html lang="zh-CN">
                  <head>
                    <meta charset="utf-8">
                    <title>GEO模拟AI平台</title>
                    <style>
                      body {
                        margin: 0;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                        background: #f6f7f9;
                        color: #202124;
                      }
                      main { max-width: 920px; margin: 0 auto; padding: 40px 32px 120px; }
                      h1 { margin: 0 0 18px; font-size: 24px; }
                      .chat { display: grid; gap: 14px; }
                      .message {
                        border: 1px solid #dadce0;
                        border-radius: 10px;
                        padding: 16px 18px;
                        background: white;
                        line-height: 1.8;
                        font-size: 16px;
                      }
                      .user { background: #eef4ff; }
                      .composer {
                        position: fixed;
                        left: 50%;
                        bottom: 20px;
                        transform: translateX(-50%);
                        display: flex;
                        gap: 10px;
                        width: min(920px, calc(100vw - 64px));
                        padding: 12px;
                        border: 1px solid #dadce0;
                        border-radius: 12px;
                        background: white;
                        box-shadow: 0 12px 32px rgba(60, 64, 67, .18);
                      }
                      textarea { flex: 1; min-height: 48px; resize: vertical; border: 1px solid #dadce0; border-radius: 8px; padding: 10px; font-size: 15px; }
                      button { width: 88px; border: 0; border-radius: 8px; background: #1a73e8; color: white; font-size: 15px; cursor: pointer; }
                    </style>
                  </head>
                  <body>
                    <main>
                      <h1>GEO模拟AI平台</h1>
                      <section class="chat" id="chat">
                        <div class="message">这是本地模拟平台，用来测试插件自动提问、关键词标注、截图和 Excel 回写。</div>
                      </section>
                    </main>
                    <form class="composer" id="composer">
                      <textarea placeholder="请输入问题"></textarea>
                      <button type="submit">发送</button>
                    </form>
                    <script>
                      const chat = document.getElementById('chat');
                      const form = document.getElementById('composer');
                      const textarea = form.querySelector('textarea');
                      let count = 0;

                      function addMessage(text, cls) {
                        const div = document.createElement('div');
                        div.className = 'message ' + (cls || '');
                        div.textContent = text;
                        chat.appendChild(div);
                        div.scrollIntoView({ block: 'center' });
                      }

                      form.addEventListener('submit', (event) => {
                        event.preventDefault();
                        const question = textarea.value.trim();
                        if (!question) return;
                        textarea.value = '';
                        count += 1;
                        addMessage(question, 'user');
                        setTimeout(() => {
                          if (question.includes('第二') || question.includes('生活费')) {
                            addMessage('模拟回答：这个问题可以比较贵州商学院、贵阳学院等学校。这里故意命中第二个关键词贵州商学院，用来测试 OR 关系。');
                          } else if (count >= 6) {
                            addMessage('模拟回答：经过多轮追问后，仍然没有推荐目标学校，用来测试未命中截图。');
                          } else {
                            addMessage('模拟回答：结合贵州地区应用型本科和商科方向，可以重点关注贵阳商学院。这里包含目标关键词，插件应该滚动到这里并用红框标注。');
                          }
                        }, 800);
                      });
                    </script>
                  </body>
                </html>
                """
            )
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self._json_body()
            if path == "/submit-result":
                self._send(200, submit_result(payload))
            elif path == "/save-test-screenshot":
                self._send(200, save_test_screenshot(payload))
            elif path == "/task-failed":
                self._send(200, mark_failed(payload))
            elif path == "/reset-failed-tasks":
                self._send(200, reset_failed_tasks())
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            print(f"接口错误 {path}: {exc}")
            self._send(500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print(f"[{now()}] {self.address_string()} {fmt % args}")


def main():
    init_db()
    created = seed_tasks()
    print(f"已准备任务，新增 {created} 条")
    print(f"输入 Excel：{INPUT_EXCEL}")
    print(f"结果 Excel：{RESULT_EXCEL}")
    print(f"截图目录：{SCREENSHOT_DIR}")
    print(f"服务地址：http://{HOST}:{PORT}")
    print("先启动本服务，再在 Chrome 加载插件并点击开始。")

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")


if __name__ == "__main__":
    main()
