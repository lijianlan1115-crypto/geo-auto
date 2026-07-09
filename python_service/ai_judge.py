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


def normalize_text(value):
    return re.sub(r"[\s，。！？、,.!?；;：:（）()【】\[\]《》<>\-]+", "", str(value or ""))


def split_paragraphs(text):
    chunks = re.split(r"\n+|(?<=[。！？!?])", str(text or ""))
    return [item.strip() for item in chunks if item and item.strip()]


def keyword_aliases(keyword):
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
    begin = max(text.rfind("\n", 0, index), text.rfind("。", 0, index), text.rfind("！", 0, index), text.rfind("？", 0, index))
    end_candidates = [pos for pos in [text.find("\n", index), text.find("。", index), text.find("！", index), text.find("？", index)] if pos >= 0]
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
            return {"matched": True, "keyword": keyword, "matched_text": alias, "evidence": paragraph_for_index(text, index), "match_type": "exact", "confidence": 1.0}
        normalized_alias = normalize_text(alias)
        normalized_index = normalized_text.find(normalized_alias) if normalized_alias else -1
        if normalized_index >= 0:
            evidence = best_paragraph_by_alias(text, normalized_alias) or text[:200]
            return {"matched": True, "keyword": keyword, "matched_text": alias, "evidence": evidence, "match_type": "normalized", "confidence": 0.98}
    return None


def local_judge(answer_text, keywords):
    text = str(answer_text or "").strip()
    if len(normalize_text(text)) < 20:
        return {"ok": True, "has_answer": False, "matched": False, "reason": "未获取到足够长度的平台正文回答", "source": "local"}
    for keyword in keywords or []:
        hit = find_evidence(text, keyword)
        if hit:
            return {"ok": True, "has_answer": True, **hit, "reason": "回答正文中找到目标词或通用别名", "source": "local"}
    return {"ok": True, "has_answer": True, "matched": False, "reason": "回答正文已获取，但本地规则未发现目标词", "source": "local"}


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
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {RUNTIME_CONFIG.get('api_key')}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def ai_judge(answer_text, keywords, question="", platform=""):
    local = local_judge(answer_text, keywords)
    if local.get("matched") or not local.get("has_answer"):
        return local
    if not (RUNTIME_CONFIG.get("enabled") and RUNTIME_CONFIG.get("api_url") and RUNTIME_CONFIG.get("api_key") and RUNTIME_CONFIG.get("model")):
        return local
    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {"role": "system", "content": "你是本地GEO反馈检测质检器。你只判断一段AI平台回复是否真实提到了目标对象。适用于学校、酒店、品牌、产品、机构、政策、服务、地点等不同场景。必须返回严格JSON，不要输出解释文本。"},
            {"role": "user", "content": json.dumps({"platform": platform, "question": str(question or "")[:800], "target_keywords": keywords or [], "matching_rules": ["只要回答正文真实出现目标关键词、目标对象名称、明确简称或通用别名，可以算命中。", "如果只是泛泛提到某一类别，不指向目标对象本身，不算命中。", "evidence必须摘自answer_text中实际出现的原文片段。"], "answer_text": str(answer_text or "")[:12000], "return_schema": {"matched": "boolean，是否在语义上指向任一目标关键词", "keyword": "命中的目标关键词，没有则为空字符串", "matched_text": "回答中实际出现的证据词，没有则为空字符串", "evidence": "回答原文里最能证明命中的一句或一小段，必须来自answer_text", "confidence": "0到1", "reason": "简短原因"}}, ensure_ascii=False)},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    try:
        body = call_chat_completions(payload)
        judged = json.loads(body["choices"][0]["message"]["content"])
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        local["ai_error"] = str(exc)
        return local
    matched = bool(judged.get("matched"))
    evidence = str(judged.get("evidence") or "").strip()
    keyword = str(judged.get("keyword") or (keywords[0] if keywords else "")).strip()
    matched_text = str(judged.get("matched_text") or keyword).strip()
    if matched and evidence and evidence not in str(answer_text or ""):
        matched = False
    return {"ok": True, "has_answer": True, "matched": matched, "keyword": keyword if matched else "", "matched_text": matched_text if matched else "", "evidence": evidence if matched else "", "match_type": "ai_semantic" if matched else "none", "confidence": float(judged.get("confidence") or 0), "reason": str(judged.get("reason") or "AI语义判定"), "source": "ai"}


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
    return text if len(text) <= limit else text[-limit:]


def infer_target_profile(keywords, question=""):
    """给追问模型看的内部画像：帮助它靠近目标，但追问不能直接说目标名。"""
    raw_text = " ".join([str(item or "") for item in (keywords or [])])
    q_text = str(question or "")
    joined = raw_text + " " + q_text

    regions = []
    for region in [
        "贵州", "贵阳", "遵义", "六盘水", "安顺", "毕节", "铜仁", "黔南", "黔东南", "黔西南",
        "北京", "上海", "广州", "深圳", "成都", "重庆", "杭州", "武汉", "西安", "南京", "苏州",
    ]:
        if region in joined and region not in regions:
            regions.append(region)

    category = "对象/机构/品牌"
    category_clues = []
    if re.search(r"大学|学院|学校|院校|本科|专科|职业技术", raw_text):
        category = "院校/教育机构"
        category_clues = ["同地区", "同层次", "同类型专业", "录取难度", "就业方向"]
    elif re.search(r"酒店|宾馆|民宿|客栈|栖筑|电竞酒店", raw_text):
        category = "酒店/住宿"
        category_clues = ["同商圈", "同价位", "同档次", "入住体验", "交通位置"]
    elif re.search(r"公司|科技|集团|有限|企业|工作室|服务商", raw_text):
        category = "公司/服务商"
        category_clues = ["本地交付", "客户案例", "行业经验", "售后响应", "长期合作"]
    elif re.search(r"医院|门诊|诊所|科室", raw_text):
        category = "医疗机构"
        category_clues = ["同地区", "专科能力", "口碑", "就诊便利", "服务能力"]
    elif re.search(r"景区|公园|古镇|博物馆|旅游|度假", raw_text):
        category = "文旅/景区"
        category_clues = ["同城市", "游玩场景", "交通便利", "口碑", "适合人群"]
    elif re.search(r"产品|系统|平台|软件|APP|工具", raw_text + q_text):
        category = "产品/软件/平台"
        category_clues = ["功能匹配", "使用场景", "价格", "交付服务", "替代方案"]

    return {
        "target_keywords_internal": keywords,
        "category": category,
        "regions": regions,
        "category_clues": category_clues,
        "guidance": "追问要把被测AI拉回原问题，并逐步增加与目标对象相同的地区、类型、层次、场景或服务能力约束，让它更可能自然列出目标对象。",
    }


def followup_strategy(followup_count):
    try:
        count = int(followup_count or 0)
    except Exception:
        count = 0
    if count <= 0:
        return "第一轮追问：要求补充上一轮遗漏的具体名称，并强调同地区/同类型/同场景，不要泛泛扩展。"
    if count == 1:
        return "第二轮追问：进一步收窄到目标对象画像里的地区、类别、层次或服务能力，让被测AI重新核对是否有遗漏。"
    return "第三轮追问：要求只给新增候选，并按最贴近原问题条件的对象核对遗漏，避免继续发散。"


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
    return bool(RUNTIME_CONFIG.get("api_url") and RUNTIME_CONFIG.get("api_key") and RUNTIME_CONFIG.get("model"))


def normalize_conversation_item(item):
    if not isinstance(item, dict):
        return None
    role = str(item.get("role") or "").strip()
    content = str(item.get("content") or "").strip()
    if role not in ("user", "assistant") or not content:
        return None
    return {"role": role, "content": content[:4000]}


def parse_followup_context(question, answer_text, platform):
    ctx = {}
    if isinstance(question, dict):
        ctx = dict(question)
    else:
        text = str(question or "").strip()
        if text.startswith("{"):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    ctx = parsed
            except Exception:
                ctx = {}
    previous_question = str(ctx.get("question") or question or "").strip()
    real_answer = str(ctx.get("answer") or answer_text or "").strip()
    real_platform = str(ctx.get("platform") or platform or "").strip()
    conversation = [normalize_conversation_item(item) for item in (ctx.get("conversation") or [])]
    conversation = [item for item in conversation if item]
    if not conversation and previous_question and real_answer:
        conversation = [{"role": "user", "content": previous_question}, {"role": "assistant", "content": real_answer}]
    return previous_question, real_answer, real_platform, conversation


def generate_followup(question, answer_text, keywords, followup_count=0, platform=""):
    keywords = [str(item).strip() for item in (keywords or []) if str(item).strip()]
    previous_question, real_answer, real_platform, conversation = parse_followup_context(question, answer_text, platform)
    if not keywords:
        return {"ok": False, "prompt": "", "source": "error", "reason": "缺少目标关键词", "real_answer_valid": False, "conversation_turns": len(conversation)}
    if len(normalize_text(real_answer)) < 20:
        return {"ok": False, "prompt": "", "source": "error", "reason": "没有获取到足够长度的平台真实回复，停止追问", "real_answer_valid": False, "conversation_turns": len(conversation)}
    if not followup_config_ready():
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问接口配置不完整，已停止追问，避免使用固定模板", "real_answer_valid": True, "conversation_turns": len(conversation)}

    forbidden_terms = sorted({alias for keyword in keywords for alias in keyword_aliases(keyword)}, key=len, reverse=True)
    safe_conversation = []
    for item in conversation[-8:]:
        safe_conversation.append({"role": item["role"], "content": redact_forbidden_terms(compact_for_prompt(item["content"], 1800), keywords)})

    target_profile = infer_target_profile(keywords, previous_question)
    structured_input = {
        "question": redact_forbidden_terms(compact_for_prompt(previous_question, 900), keywords),
        "answer": redact_forbidden_terms(compact_for_prompt(real_answer, 2400), keywords),
        "platform": real_platform,
        "conversation": safe_conversation,
        "followup_count": followup_count,
        "forbidden_terms": forbidden_terms,
        "target_profile_internal": target_profile,
        "strategy": followup_strategy(followup_count),
        "task": "生成一句目标导向追问：目标是让被测AI在下一轮回答中更可能自然提到 target_profile_internal.target_keywords_internal 里的对象，但追问文本本身绝不能出现这些词。",
        "rules": [
            "必须围绕原始问题继续问，不能换话题，不能越问越宽泛。",
            "必须根据最后一条assistant真实回答中的缺口追问，同时叠加目标画像里的地区、类别、层次、场景或服务能力约束。",
            "追问要像普通用户自然追问，不能暴露测试、命中、目标词、关键词、GEO检测等意图。",
            "不要出现任何forbidden_terms中的词或其明显变体。",
            "不能直接给出目标关键词、目标对象名称、简称或别名。",
            "优先问：是否遗漏了同地区/同类型/同定位/同场景的具体名称，而不是泛泛问更多信息。",
            "如果上一轮回答已经列了很多对象，就要求只补充新增且最贴近原条件的候选。",
            "不能输出代码、SQL、JSON、HTML、操作步骤、列表或多条问题。",
            "只能问一个方向，40到120个中文字符。",
        ],
        "bad_examples": [
            "还有别的吗？",
            "能不能再详细介绍一下？",
            "请继续补充更多选择。",
        ],
        "good_pattern": "除了刚才这些，是否还遗漏了【同地区/同类型/同场景】且【更贴近原问题条件】的具体名称？请只补充新增候选。",
        "return_schema": {"prompt": "下一轮追问文本", "intent": "为什么这样追问，20字以内"},
    }

    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {"role": "system", "content": "你是GEO反馈检测追问生成器。你会收到结构化输入：question、answer、conversation、target_profile_internal。你要用内部目标画像设计追问，让被测AI更可能自然提到目标对象；但你输出的追问绝不能出现目标对象名称、简称或别名。只返回严格JSON。"},
            {"role": "user", "content": json.dumps(structured_input, ensure_ascii=False)},
        ],
        "temperature": 0.28,
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
        return {"ok": False, "prompt": "", "source": "error", "reason": f"AI追问生成失败：{exc}", "real_answer_valid": True, "conversation_turns": len(conversation)}

    prompt = str(prompt or "").strip()
    if not prompt:
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问为空", "real_answer_valid": True, "conversation_turns": len(conversation)}
    if contains_forbidden_keyword(prompt, keywords):
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问包含目标关键词或别名，已停止追问", "real_answer_valid": True, "conversation_turns": len(conversation), "target_profile": target_profile}
    if len(prompt) > 160 or "\n" in prompt:
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问格式不合规，已停止追问", "real_answer_valid": True, "conversation_turns": len(conversation), "target_profile": target_profile}

    return {"ok": True, "prompt": prompt, "source": "ai", "intent": intent, "api_mode": api_mode, "real_answer_valid": True, "conversation_turns": len(conversation), "used_structured_context": True, "target_directed": True, "target_profile": {"category": target_profile.get("category"), "regions": target_profile.get("regions"), "category_clues": target_profile.get("category_clues")}}
