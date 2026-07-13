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

QUICK_JUDGE_TIMEOUT_SECONDS = 4
QUICK_FOLLOWUP_TIMEOUT_SECONDS = 6


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


def call_chat_completions(payload, timeout_seconds=None):
    request = urllib.request.Request(
        chat_completions_url(),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {RUNTIME_CONFIG.get('api_key')}"},
        method="POST",
    )
    timeout = timeout_seconds or RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS
    with urllib.request.urlopen(request, timeout=timeout) as response:
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
        runtime_timeout = int(RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS)
        judge_timeout = max(3, min(QUICK_JUDGE_TIMEOUT_SECONDS, runtime_timeout))
        body = call_chat_completions(payload, timeout_seconds=judge_timeout)
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
    scenario_clues = []
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
    elif re.search(r"餐厅|饭店|餐饮|辣子鸡|火锅|酸汤|小吃|食品|特产|门店|酒楼|餐馆", raw_text):
        category = "餐饮门店/食品品牌"
        category_clues = ["同城市", "同品类", "本地老字号", "门店口碑", "购买或包装方式"]
    elif re.search(r"产品|系统|平台|软件|APP|工具", raw_text + q_text):
        category = "产品/软件/平台"
        category_clues = ["功能匹配", "使用场景", "价格", "交付服务", "替代方案"]

    if re.search(r"长辈|老人|父母|爷爷|奶奶", q_text) and re.search(r"故事|经历|一生|人生", q_text):
        scenario_clues.extend(["长辈口述经历整理", "人生故事影像化", "回忆录或传记制作", "家庭纪念"])
    if re.search(r"人生剧|人生电影|影像|视频", q_text):
        scenario_clues.extend(["人生影像制作", "口述史采访", "脚本策划", "成片交付"])
    if re.search(r"回忆录|传记|家谱", q_text):
        scenario_clues.extend(["资料采集", "采访整理", "内容创作", "图文或影像交付"])
    if re.search(r"真空包装|邮寄|伴手礼|特产", q_text):
        scenario_clues.extend(["真空包装", "可邮寄", "本地门店", "伴手礼购买"])
    scenario_clues = list(dict.fromkeys(scenario_clues))

    return {
        "target_keywords_internal": keywords,
        "category": category,
        "regions": regions,
        "category_clues": category_clues,
        "scenario_clues": scenario_clues,
        "guidance": "目标画像和原始问题意图优先于上一轮回答。追问应主动增加与目标对象相同的地区、类型、场景和服务能力约束，让被测AI更可能自然列出目标对象。",
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
        return {"ok": False, "prompt": "", "source": "error", "reason": "AI追问接口配置不完整", "real_answer_valid": True, "conversation_turns": len(conversation)}

    original_question = next(
        (item["content"] for item in conversation if item.get("role") == "user" and item.get("content")),
        previous_question,
    )
    forbidden_terms = sorted({alias for keyword in keywords for alias in keyword_aliases(keyword)}, key=len, reverse=True)
    safe_conversation = []
    normalized_real_answer = normalize_text(real_answer)
    for item in conversation[-6:]:
        if item["role"] == "assistant" and normalize_text(item["content"]) == normalized_real_answer:
            continue
        safe_conversation.append({"role": item["role"], "content": redact_forbidden_terms(compact_for_prompt(item["content"], 900), keywords)})

    target_profile = infer_target_profile(keywords, original_question)
    structured_input = {
        "original_question": redact_forbidden_terms(compact_for_prompt(original_question, 900), keywords),
        "latest_question": redact_forbidden_terms(compact_for_prompt(previous_question, 900), keywords),
        "latest_answer": redact_forbidden_terms(compact_for_prompt(real_answer, 1800), keywords),
        "platform": real_platform,
        "conversation": safe_conversation,
        "followup_count": followup_count,
        "forbidden_terms": forbidden_terms,
        "target_profile_internal": target_profile,
        "priority_order": [
            "1. target_profile_internal：最高优先级，用于决定追问要靠近的地区、类别、场景和能力",
            "2. original_question：第二优先级，必须保持用户最初目的和使用场景",
            "3. latest_answer：第三优先级，只用于识别已提及内容和遗漏，不能把追问方向带离目标画像",
        ],
        "strategy": followup_strategy(followup_count),
        "task": "在内部生成3个不同的追问候选，比较哪个最可能让被测AI自然列出 target_profile_internal.target_keywords_internal 中的对象，然后只输出得分最高的一句。最终追问绝不能出现目标对象名称、简称、别名或明显变体。",
        "rules": [
            "严格遵守 priority_order；即使 latest_answer 内容很丰富或已经偏题，也要优先服从目标画像和原始问题。",
            "必须围绕 original_question 继续问，不能换话题，不能越问越宽泛。",
            "必须同时使用目标画像中的地区、类别、scenario_clues 和服务能力约束，形成高信息量、强指向但自然的用户问题。",
            "latest_answer 只用于避免重复已有候选、发现遗漏和选择下一步收窄角度，不能成为追问的最高优先级。",
            "追问要像普通用户自然追问，不能暴露测试、命中、目标词、关键词、GEO检测等意图。",
            "不要出现任何forbidden_terms中的词或其明显变体。",
            "不能直接给出目标关键词、目标对象名称、简称或别名。",
            "优先要求补充同地区、同类型、同场景且具备具体交付能力的名称，而不是泛泛问更多信息。",
            "如果上一轮回答已经列了很多对象，就要求只补充新增且最贴近原条件的候选。",
            "每轮追问都要比上一轮增加至少一个有效约束，例如地区、服务对象、交付形式、案例能力或购买条件。",
            "不能输出代码、SQL、JSON、HTML、操作步骤、列表或多条问题。",
            "只能问一个方向，40到120个中文字符。",
        ],
        "bad_examples": [
            "还有别的吗？",
            "能不能再详细介绍一下？",
            "请继续补充更多选择。",
        ],
        "good_pattern": "如果要在【目标地区】寻找能为【原始服务对象】提供【目标场景与交付形式】的专业团队，还应重点比较哪些有真实案例和完整交付能力的服务商？请只补充前面未出现的名称。",
        "return_schema": {"prompt": "下一轮追问文本", "intent": "为什么这样追问，20字以内"},
    }

    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {"role": "system", "content": "你是高命中率GEO追问生成器。优先级固定为：隐藏目标画像 > 原始问题意图 > 最新回答。最新回答只能帮助识别遗漏，不能改变目标方向。你必须在内部比较3个候选问题，选择最可能自然引出目标对象的一句；最终文本绝不能出现目标名称、简称、别名或明显变体。只返回严格JSON。"},
            {"role": "user", "content": json.dumps(structured_input, ensure_ascii=False)},
        ],
        "temperature": 0.28,
        "response_format": {"type": "json_object"},
    }

    runtime_timeout = int(RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS)
    followup_timeout = max(4, min(QUICK_FOLLOWUP_TIMEOUT_SECONDS, runtime_timeout))
    attempt_errors = []

    for attempt in range(2):
        attempt_payload = dict(payload)
        attempt_payload["messages"] = [dict(item) for item in payload["messages"]]
        api_mode = "json_object" if attempt == 0 else "plain_retry"
        if attempt > 0:
            attempt_payload.pop("response_format", None)
            attempt_payload["messages"][0]["content"] += "这是独立重试。只返回一句合规追问，不要解释，不要包含目标名称。"
        try:
            body = call_chat_completions(attempt_payload, timeout_seconds=followup_timeout)
            content = body["choices"][0]["message"]["content"]
            prompt, intent = parse_followup_content(content)
            prompt = str(prompt or "").strip()
            if not prompt:
                raise ValueError("AI追问为空")
            if contains_forbidden_keyword(prompt, keywords):
                raise ValueError("AI追问包含目标关键词或别名")
            if len(prompt) > 160 or "\n" in prompt:
                raise ValueError("AI追问格式不合规")
            return {"ok": True, "prompt": prompt, "source": "ai", "intent": intent, "api_mode": api_mode, "retry_count": attempt, "real_answer_valid": True, "conversation_turns": len(conversation), "used_structured_context": True, "target_directed": True, "target_profile": {"category": target_profile.get("category"), "regions": target_profile.get("regions"), "category_clues": target_profile.get("category_clues")}}
        except Exception as exc:
            attempt_errors.append(str(exc))

    return {
        "ok": False,
        "prompt": "",
        "source": "error",
        "reason": f"AI追问生成失败，已独立重试1次：{'；'.join(attempt_errors)}",
        "real_answer_valid": True,
        "conversation_turns": len(conversation),
        "used_structured_context": True,
    }
