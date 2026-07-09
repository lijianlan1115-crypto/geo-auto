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
    AI_JUDGE_CONFIG_PATH.write_text(json.dumps(RUNTIME_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8")


load_persisted_ai_config()


SCHOOL_SUFFIXES = ("大学", "学院", "学校", "院校")


def normalize_text(value):
    return re.sub(r"[\s，。！？、,.!?；;：:（）()【】\[\]《》<>-]+", "", str(value or ""))


def split_paragraphs(text):
    chunks = re.split(r"\n+|(?<=[。！？!?])", str(text or ""))
    return [item.strip() for item in chunks if item and item.strip()]


def keyword_aliases(keyword):
    raw = str(keyword or "").strip()
    aliases = {raw}
    normalized = normalize_text(raw)
    if normalized:
        aliases.add(normalized)

    # 仅保留贵阳/贵州相互替换（用户明确要求的变体）
    if raw.startswith("贵阳"):
        aliases.add("贵州" + raw[2:])
    if raw.startswith("贵州"):
        aliases.add("贵阳" + raw[2:])

    return [item for item in aliases if item]


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


def paragraph_for_index(text, index):
    begin = max(text.rfind("\n", 0, index), text.rfind("。", 0, index), text.rfind("！", 0, index), text.rfind("？", 0, index))
    end_candidates = [pos for pos in [text.find("\n", index), text.find("。", index), text.find("！", index), text.find("？", index)] if pos >= 0]
    end = min(end_candidates) + 1 if end_candidates else min(len(text), index + 220)
    return text[max(0, begin + 1):end].strip()[:260]


def best_paragraph_by_alias(text, normalized_alias):
    for paragraph in split_paragraphs(text):
        if normalized_alias in normalize_text(paragraph):
            return paragraph[:260]
    return ""


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
                "reason": "回答正文中找到目标词或常见别名",
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
                    "你是本地自动化质检器。只判断一段AI平台回复是否真实讨论了目标对象。"
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
                            "目标对象的简称、常见简称、同校区项目、中外合作项目、国际项目都可以算作同一目标对象。",
                            "如果回答只是泛泛提到商学院这个类别，不指向目标对象本身，则不要算命中。",
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

    request = urllib.request.Request(
        chat_completions_url(),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {RUNTIME_CONFIG.get('api_key')}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        local["ai_error"] = str(exc)
        return local

    content = ""
    try:
        content = body["choices"][0]["message"]["content"]
        judged = json.loads(content)
    except Exception as exc:
        local["ai_error"] = f"AI判定返回无法解析：{exc}; {content[:200]}"
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
            if normalize_text(alias) and normalize_text(alias) in normalized:
                return True
    return False


def redact_forbidden_terms(text, keywords):
    result = str(text or "")
    aliases = sorted({alias for keyword in (keywords or []) for alias in keyword_aliases(keyword)}, key=len, reverse=True)
    for alias in aliases:
        if alias:
            result = result.replace(alias, "该候选项")
    return result


def fallback_followup(followup_count, question="", answer_text="", keywords=None):
    prompts = [
        "刚才这些推荐里，是否还遗漏了同地区、同类型、定位相近的具体候选项？如果有，请只补充新增名称和一句理由。",
        "能不能再从录取难度、费用和本地就业便利性三个角度核对一下，还有没有更稳妥或性价比更高的同类选择？",
        "最后请只补充前面没有提到、但和这个问题条件接近的候选项，不要重写已有内容。",
    ]
    return prompts[min(int(followup_count or 0), len(prompts) - 1)]


def compact_for_prompt(text, limit):
    text = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


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
    with urllib.request.urlopen(request, timeout=RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


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


def generate_followup(question, answer_text, keywords, followup_count=0, platform=""):
    fallback = fallback_followup(followup_count, question, answer_text, keywords)
    if not (
        RUNTIME_CONFIG.get("api_url")
        and RUNTIME_CONFIG.get("api_key")
        and RUNTIME_CONFIG.get("model")
    ):
        return {"ok": True, "prompt": fallback, "source": "fallback", "reason": "AI接口配置不完整"}

    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是本地GEO测试追问预判器。你只生成一句发给被测AI平台的下一轮追问。"
                    "你只能参考上一轮实际提问和这一轮回答摘要，生成自然连续的一句话。"
                    "不要输出摘要、说明、规则、标题、编号或多段文本。不要暴露测试目标，不能出现禁用词。"
                    "只返回严格JSON，不要输出解释文本。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "platform": platform,
                        "followup_count": followup_count,
                        "previous_question": redact_forbidden_terms(compact_for_prompt(question, 600), keywords or []),
                        "current_answer_summary": redact_forbidden_terms(compact_for_prompt(answer_text, 1200), keywords or []),
                        "forbidden_terms": sorted({alias for keyword in (keywords or []) for alias in keyword_aliases(keyword)}),
                        "task": "只生成一句下一轮追问，不要回答问题本身。",
                        "rules": [
                            "不要出现任何forbidden_terms中的词或其明显变体。",
                            "追问问题本身绝对不能直接给出目标关键词、目标对象名称、简称或别名。",
                            "只能根据上一轮回答的缺口，用地区、类型、费用、录取难度、就业去向、同层次候选等条件间接引导被测平台自己补充目标对象。",
                            "不能包含“原问题摘要”“上一轮回答摘要”“要求”等元信息。",
                            "不能说你是测试器，也不能要求对方确认目标对象是否适合。",
                            "不能输出代码、SQL、JSON、HTML、操作步骤、列表或多条问题。",
                            "追问必须承接上一轮问题和本轮回答里缺失的信息，只问一个方向。",
                            "如果回答已经列了很多候选，就问是否遗漏同地区/同类型/定位相近的新增候选，不要要求重写全文。",
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
        "temperature": 0.4,
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
            relaxed_payload["messages"][0]["content"] = (
                relaxed_payload["messages"][0]["content"]
                + "如果接口不支持JSON模式，也可以只返回一句追问文本，不要返回其他说明。"
            )
            body = call_chat_completions(relaxed_payload)
            api_mode = "plain_retry"
        content = body["choices"][0]["message"]["content"]
        prompt, intent = parse_followup_content(content)
    except Exception as exc:
        return {"ok": True, "prompt": fallback, "source": "fallback", "reason": f"AI追问生成失败：{exc}"}

    if not prompt or contains_forbidden_keyword(prompt, keywords):
        return {"ok": True, "prompt": fallback, "source": "fallback", "reason": "AI追问为空或包含目标关键词/别名，已改用安全兜底追问"}
    return {"ok": True, "prompt": prompt, "source": "ai", "intent": intent, "api_mode": api_mode}
