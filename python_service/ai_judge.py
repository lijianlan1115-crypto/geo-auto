import json
import re
import urllib.error
import urllib.request

from config import (
    AI_JUDGE_CONFIG_PATH,
    AI_JUDGE_API_KEY,
    AI_JUDGE_API_URL,
    AI_JUDGE_ENABLED,
    AI_JUDGE_MODEL,
    AI_JUDGE_TIMEOUT_SECONDS,
)


RUNTIME_CONFIG = {
    "enabled": AI_JUDGE_ENABLED,
    "api_url": AI_JUDGE_API_URL,
    "api_key": AI_JUDGE_API_KEY,
    "model": AI_JUDGE_MODEL,
    "timeout_seconds": AI_JUDGE_TIMEOUT_SECONDS,
}


def load_persisted_ai_config():
    try:
        if not AI_JUDGE_CONFIG_PATH.exists():
            return
        data = json.loads(AI_JUDGE_CONFIG_PATH.read_text(encoding="utf-8"))
        for key in ("enabled", "api_url", "api_key", "model", "timeout_seconds"):
            if key in data and data[key] not in (None, ""):
                RUNTIME_CONFIG[key] = data[key]
    except Exception:
        return


def save_persisted_ai_config():
    AI_JUDGE_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    AI_JUDGE_CONFIG_PATH.write_text(
        json.dumps(RUNTIME_CONFIG, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


load_persisted_ai_config()


def normalize_text(value):
    return re.sub(r"[\s，。！？、,.!?；;：:（）()【】\[\]《》<>\-]+", "", str(value or ""))


def split_paragraphs(text):
    chunks = re.split(r"\n+|(?<=[。！？!?])", str(text or ""))
    return [item.strip() for item in chunks if item and item.strip()]


def keyword_aliases(keyword):
    """
    通用关键词别名：
    - 原词
    - 去空格/标点后的规范化词
    - 贵阳/贵州地域互换（保留用户之前明确需要的地域变体）
    不再写死学校、商学院、品牌等具体场景别名，避免影响其他 GEO 业务。
    """
    raw = str(keyword or "").strip()
    aliases = {raw}
    normalized = normalize_text(raw)
    if normalized:
        aliases.add(normalized)
    if raw.startswith("贵阳"):
        aliases.add("贵州" + raw[2:])
    if raw.startswith("贵州"):
        aliases.add("贵阳" + raw[2:])
    return [item for item in aliases if item]


def paragraph_for_index(text, index):
    begin = max(
        text.rfind("\n", 0, index),
        text.rfind("。", 0, index),
        text.rfind("！", 0, index),
        text.rfind("？", 0, index),
    )
    end_candidates = [
        pos
        for pos in [
            text.find("\n", index),
            text.find("。", index),
            text.find("！", index),
            text.find("？", index),
        ]
        if pos >= 0
    ]
    end = min(end_candidates) + 1 if end_candidates else min(len(text), index + 220)
    return text[max(0, begin + 1):end].strip()[:260]


def best_paragraph_by_alias(text, normalized_alias):
    for paragraph in split_paragraphs(text):
        if normalized_alias in normalize_text(paragraph):
            return paragraph[:260]
    return ""


def find_evidence(answer_text, keyword):
    text = str(answer_text or "")
    normalized_text = normalize_text(text)
    for alias in keyword_aliases(keyword):
        index = text.find(alias)
        if index >= 0:
            return {
                "matched": True,
                "keyword": keyword,
                "matched_text": alias,
                "evidence": paragraph_for_index(text, index),
                "match_type": "exact",
                "confidence": 1.0,
            }
        normalized_alias = normalize_text(alias)
        normalized_index = normalized_text.find(normalized_alias) if normalized_alias else -1
        if normalized_index >= 0:
            evidence = best_paragraph_by_alias(text, normalized_alias) or text[:200]
            return {
                "matched": True,
                "keyword": keyword,
                "matched_text": alias,
                "evidence": evidence,
                "match_type": "normalized",
                "confidence": 0.98,
            }
    return None


def local_judge(answer_text, keywords):
    text = str(answer_text or "").strip()
    if len(normalize_text(text)) < 20:
        return {
            "ok": True,
            "has_answer": False,
            "matched": False,
            "reason": "未获取到足够长度的平台正文回答",
            "source": "local",
        }

    for keyword in keywords or []:
        hit = find_evidence(text, keyword)
        if hit:
            return {
                "ok": True,
                "has_answer": True,
                **hit,
                "reason": "回答正文中找到目标词或通用别名",
                "source": "local",
            }
    return {
        "ok": True,
        "has_answer": True,
        "matched": False,
        "reason": "回答正文已获取，但本地规则未发现目标词",
        "source": "local",
    }


def configure_ai_judge(payload):
    RUNTIME_CONFIG["enabled"] = bool(payload.get("enabled"))
    RUNTIME_CONFIG["api_url"] = str(payload.get("api_url") or "").strip()
    RUNTIME_CONFIG["model"] = str(payload.get("model") or "").strip()
    api_key = str(payload.get("api_key") or "").strip()
    if api_key:
        RUNTIME_CONFIG["api_key"] = api_key
    elif payload.get("clear_api_key"):
        RUNTIME_CONFIG["api_key"] = ""
    timeout = payload.get("timeout_seconds")
    if timeout:
        try:
            RUNTIME_CONFIG["timeout_seconds"] = max(5, min(60, int(timeout)))
        except Exception:
            pass
    save_persisted_ai_config()
    return get_ai_judge_config()


def chat_completions_url():
    url = str(RUNTIME_CONFIG.get("api_url") or "").strip().rstrip("/")
    if not url:
        return url
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/v1"):
        return f"{url}/chat/completions"
    return url


def get_ai_judge_config():
    key = RUNTIME_CONFIG.get("api_key") or ""
    return {
        "ok": True,
        "enabled": bool(RUNTIME_CONFIG.get("enabled")),
        "api_url": RUNTIME_CONFIG.get("api_url") or "",
        "model": RUNTIME_CONFIG.get("model") or "",
        "has_api_key": bool(key),
        "api_key_preview": f"***{key[-4:]}" if key else "",
        "timeout_seconds": RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS,
    }


def call_chat_completions(payload):
    request = urllib.request.Request(
        chat_completions_url(),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {RUNTIME_CONFIG.get('api_key')}",
        },
        method="POST",
    )
    with urllib.request.urlopen(
        request,
        timeout=RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS,
    ) as response:
        return json.loads(response.read().decode("utf-8"))


def ai_judge(answer_text, keywords, question="", platform=""):
    local = local_judge(answer_text, keywords)
    if local.get("matched") or not local.get("has_answer"):
        return local

    if not (
        RUNTIME_CONFIG.get("enabled")
        and RUNTIME_CONFIG.get("api_url")
        and RUNTIME_CONFIG.get("api_key")
        and RUNTIME_CONFIG.get("model")
    ):
        return local

    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是本地GEO反馈检测质检器。你只判断一段AI平台回复是否真实提到了目标对象。"
                    "适用于学校、酒店、品牌、产品、机构、政策、服务、地点等不同场景。"
                    "必须返回严格JSON，不要输出解释文本。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "platform": platform,
                        "question": str(question or "")[:800],
                        "target_keywords": keywords or [],
                        "matching_rules": [
                            "只要回答正文真实出现目标关键词、目标对象名称、明确简称或通用别名，可以算命中。",
                            "如果只是泛泛提到某一类别，不指向目标对象本身，不算命中。",
                            "evidence必须摘自answer_text中实际出现的原文片段。",
                        ],
                        "answer_text": str(answer_text or "")[:12000],
                        "return_schema": {
                            "matched": "boolean，是否在语义上指向任一目标关键词",
                            "keyword": "命中的目标关键词，没有则为空字符串",
                            "matched_text": "回答中实际出现的证据词，没有则为空字符串",
                            "evidence": "回答原文里最能证明命中的一句或一小段，必须来自answer_text",
                            "confidence": "0到1",
                            "reason": "简短原因",
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }

    try:
        body = call_chat_completions(payload)
        content = body["choices"][0]["message"]["content"]
        judged = json.loads(content)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        local["ai_error"] = str(exc)
        return local

    matched = bool(judged.get("matched"))
    evidence = str(judged.get("evidence") or "").strip()
    keyword = str(judged.get("keyword") or (keywords[0] if keywords else "")).strip()
    matched_text = str(judged.get("matched_text") or keyword).strip()

    if matched and evidence and evidence not in str(answer_text or ""):
        matched = False

    return {
        "ok": True,
        "has_answer": True,
        "matched": matched,
        "keyword": keyword if matched else "",
        "matched_text": matched_text if matched else "",
        "evidence": evidence if matched else "",
        "match_type": "ai_semantic" if matched else "none",
        "confidence": float(judged.get("confidence") or 0),
        "reason": str(judged.get("reason") or "AI语义判定"),
        "source": "ai",
    }


def contains_forbidden_keyword(text, keywords):
    normalized = normalize_text(text)
    for keyword in keywords or []:
        for alias in keyword_aliases(keyword):
            term = normalize_text(alias)
            if term and term in normalized:
                return True
    return False


def redact_forbidden_terms(text, keywords):
    result = str(text or "")
    aliases = sorted({alias for keyword in (keywords or []) for alias in keyword_aliases(keyword)}, key=len, reverse=True)
    for alias in aliases:
        if alias:
            result = result.replace(alias, "该对象")
    return result


def compact_for_prompt(text, limit):
    text = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


def parse_followup_content(content):
    text = str(content or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I).strip()
    try:
        data = json.loads(text)
        return str(data.get("prompt") or "").strip(), str(data.get("intent") or "").strip()
    except Exception:
        pass
    lines = [line.strip(" \t\"'`-") for line in text.splitlines() if line.strip()]
    prompt = lines[0] if lines else text
    prompt = re.sub(r"^(prompt|追问|问题)\s*[:：]\s*", "", prompt, flags=re.I).strip()
    return prompt, "AI纯文本生成"


def followup_config_ready():
    return bool(
        RUNTIME_CONFIG.get("api_url")
        and RUNTIME_CONFIG.get("api_key")
        and RUNTIME_CONFIG.get("model")
    )


def generate_followup(question, answer_text, keywords, followup_count=0, platform=""):
    keywords = [str(item).strip() for item in (keywords or []) if str(item).strip()]
    if not keywords:
        return {"ok": False, "prompt": "", "source": "error", "reason": "缺少目标关键词"}
    if len(normalize_text(answer_text)) < 20:
        return {"ok": False, "prompt": "", "source": "error", "reason": "没有获取到足够长度的平台真实回复，停止追问"}
    if not followup_config_ready():
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问接口配置不完整，已停止追问，避免使用固定模板"}

    forbidden_terms = sorted({alias for keyword in keywords for alias in keyword_aliases(keyword)}, key=len, reverse=True)
    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是GEO反馈检测追问生成器。你的任务是根据上一轮AI平台真实回复，生成一句自然追问，"
                    "引导被测AI补充可能遗漏的相关对象。适用于学校、酒店、品牌、产品、机构、政策、服务、地点等任意场景。"
                    "追问必须像普通用户继续提问，不能暴露测试目的。不能出现目标关键词、目标对象名称、简称或别名。"
                    "只返回严格JSON，不要输出解释文本。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "platform": platform,
                        "followup_count": followup_count,
                        "previous_question": redact_forbidden_terms(compact_for_prompt(question, 700), keywords),
                        "current_answer_summary": redact_forbidden_terms(compact_for_prompt(answer_text, 1800), keywords),
                        "forbidden_terms": forbidden_terms,
                        "task": "只生成一句下一轮追问，不要回答问题本身。",
                        "rules": [
                            "不要出现任何forbidden_terms中的词或其明显变体。",
                            "不能直接给出目标关键词、目标对象名称、简称或别名。",
                            "只能根据上一轮回答内容的缺口，从类型、地区、价格/成本、适用人群、口碑、替代选择、服务能力、场景匹配等角度自然追问。",
                            "不能包含测试、命中、目标词、关键词、GEO检测等元信息。",
                            "不能输出代码、SQL、JSON、HTML、操作步骤、列表或多条问题。",
                            "只能问一个方向，必须承接上一轮回答。",
                            "长度控制在40到120个中文字符。",
                        ],
                        "return_schema": {
                            "prompt": "下一轮追问文本",
                            "intent": "为什么这样追问，20字以内",
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "temperature": 0.45,
        "response_format": {"type": "json_object"},
    }

    try:
        try:
            body = call_chat_completions(payload)
            api_mode = "json_object"
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
            relaxed_payload = dict(payload)
            relaxed_payload.pop("response_format", None)
            relaxed_payload["messages"] = list(relaxed_payload["messages"])
            relaxed_payload["messages"][0] = dict(relaxed_payload["messages"][0])
            relaxed_payload["messages"][0]["content"] += "如果接口不支持JSON模式，也可以只返回一句追问文本，不要返回其他说明。"
            body = call_chat_completions(relaxed_payload)
            api_mode = "plain_retry"
        content = body["choices"][0]["message"]["content"]
        prompt, intent = parse_followup_content(content)
    except Exception as exc:
        return {"ok": False, "prompt": "", "source": "error", "reason": f"AI追问生成失败：{exc}"}

    prompt = str(prompt or "").strip()
    if not prompt:
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问为空"}
    if contains_forbidden_keyword(prompt, keywords):
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问包含目标关键词或别名，已停止追问"}
    if len(prompt) > 160 or "\n" in prompt:
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问格式不合规，已停止追问"}

    return {"ok": True, "prompt": prompt, "source": "ai", "intent": intent, "api_mode": api_mode}
