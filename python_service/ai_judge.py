import html
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

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

QUICK_JUDGE_TIMEOUT_SECONDS = 2
QUICK_FOLLOWUP_TIMEOUT_SECONDS = 8
FOLLOWUP_AI_ATTEMPTS = 1
TARGET_RESEARCH_CACHE_PATH = AI_JUDGE_CONFIG_PATH.parent / "target_research_cache.json"
TARGET_RESEARCH_LOCK = threading.RLock()
TARGET_RESEARCH_CACHE = {}
TARGET_RESEARCH_INFLIGHT = set()
TARGET_RESEARCH_REFRESHED = set()


def load_target_research_cache():
    try:
        if TARGET_RESEARCH_CACHE_PATH.exists():
            data = json.loads(TARGET_RESEARCH_CACHE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                TARGET_RESEARCH_CACHE.update(data)
    except Exception:
        pass


load_target_research_cache()


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
    # 结果要求目标名称真实出现在正文中，本地精确/别名匹配已足够。
    # 不再为每个窗口额外调用一次外部模型，避免与追问生成争抢并发并产生超时。
    local["reason"] = "回答正文已获取，但本地规则未发现目标词；未调用远程语义判定"
    return local


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


def target_research_key(keywords):
    """背景研究只按目标关键词缓存；Excel 原问题在每次生成追问时单独注入。"""
    return "|".join(sorted({normalize_text(item) for item in (keywords or []) if normalize_text(item)}))


def strip_search_html(value):
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", str(value or ""), flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def research_summary_valid(summary, keywords):
    text = re.sub(r"\s+", " ", str(summary or "")).strip()
    if len(normalize_text(text)) < 80:
        return False
    normalized = normalize_text(text)
    return any(
        normalize_text(alias) in normalized
        for keyword in (keywords or [])
        for alias in keyword_aliases(keyword)
        if normalize_text(alias)
    )


def search_result_blocks(page):
    patterns = [
        r'<li[^>]+class="[^"]*res-list[^"]*"[^>]*>([\s\S]*?)</li>',
        r'<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)</li>',
        r'<div[^>]+class="[^"]*(?:vrwrap|results)[^"]*"[^>]*>([\s\S]*?)</div>',
        r'(<h3[^>]*>[\s\S]*?</h3>[\s\S]{0,1600})',
    ]
    blocks = []
    for pattern in patterns:
        blocks.extend(re.findall(pattern, page, flags=re.I)[:12])
    return blocks


def search_target_sources(keywords, timeout_seconds=5):
    """从多个公开搜索入口取证；返回来源、证据和逐来源错误。"""
    terms = [str(item).strip() for item in (keywords or []) if str(item).strip()]
    if not terms:
        return {"summary": "", "sources": [], "errors": ["缺少目标关键词"], "query": ""}
    query = " ".join(terms[:2] + ["官网", "介绍", "特点"])
    encoded = urllib.parse.quote_plus(query)
    sources = [
        ("360", f"https://www.so.com/s?q={encoded}"),
        ("bing", f"https://cn.bing.com/search?q={encoded}"),
        ("sogou", f"https://www.sogou.com/web?query={encoded}"),
        ("baidu", f"https://www.baidu.com/s?wd={encoded}"),
    ]
    snippets = []
    successful_sources = []
    errors = []
    for source_name, url in sources:
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
                    "Accept-Language": "zh-CN,zh;q=0.9",
                },
            )
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                page = response.read(700000).decode("utf-8", errors="ignore")
            source_snippets = []
            for block in search_result_blocks(page):
                text = strip_search_html(block)
                normalized = normalize_text(text)
                if len(normalized) < 20:
                    continue
                if not any(normalize_text(term) in normalized for term in terms[:2]):
                    continue
                compact = text[:420]
                if compact not in source_snippets and compact not in snippets:
                    source_snippets.append(compact)
                if len(source_snippets) >= 3:
                    break
            # 搜索引擎经常更换结果卡片 class；结构化选择器失效时，从正文中截取
            # 目标词附近的上下文，但过滤只有查询框文本的短片段。
            if not source_snippets:
                plain_page = strip_search_html(page)
                normalized_plain = normalize_text(plain_page)
                for term in terms[:2]:
                    normalized_term = normalize_text(term)
                    if not normalized_term or normalized_plain.count(normalized_term) < 2:
                        continue
                    start = 0
                    for _ in range(3):
                        index = plain_page.find(term, start)
                        if index < 0:
                            break
                        window = plain_page[max(0, index - 120):index + len(term) + 320].strip()
                        start = index + len(term)
                        if len(normalize_text(window)) >= 80 and window not in source_snippets and window not in snippets:
                            source_snippets.append(window)
                        if len(source_snippets) >= 2:
                            break
            if source_snippets:
                successful_sources.append(source_name)
                snippets.extend(source_snippets)
            else:
                errors.append(f"{source_name}:页面可访问但未解析到含目标词的结果")
        except Exception as exc:
            errors.append(f"{source_name}:{str(exc)[:180]}")
    return {
        "summary": "；".join(snippets)[:2600],
        "sources": successful_sources,
        "errors": errors,
        "query": query,
    }


def search_target_introduction(keywords, timeout_seconds=5):
    return search_target_sources(keywords, timeout_seconds).get("summary") or ""


def synthesize_target_research(keywords, web_evidence=""):
    """用已配置模型把目标资料归纳成可审计的内部背景，不直接生成追问。"""
    if not followup_config_ready():
        raise RuntimeError("AI研究接口未启用或配置不完整")
    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是GEO任务的内部背景研究员。根据目标关键词和公开检索证据，"
                    "归纳目标对象的真实类别、地区、核心特点、适用场景、可用于间接引导的筛选维度。"
                    "背景必须明确写出目标关键词本身，不能编造精确数字、资质或地址；证据不足时要标明待核实。"
                    "只返回JSON对象，字段为summary、target_type、relevance、guidance_dimensions、confidence。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "target_keywords": keywords,
                        "public_search_evidence": str(web_evidence or "")[:5000],
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "temperature": 0.15,
        "response_format": {"type": "json_object"},
    }
    runtime_timeout = int(RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS)
    body = call_chat_completions(payload, timeout_seconds=max(8, min(25, runtime_timeout)))
    content = body["choices"][0]["message"]["content"]
    data = json.loads(content)
    summary = str(data.get("summary") or "").strip()
    if not research_summary_valid(summary, keywords):
        raise ValueError("AI返回的背景研究过短或未明确包含目标对象")
    return summary


def build_target_research(keywords):
    search = search_target_sources(keywords, timeout_seconds=5)
    web_summary = str(search.get("summary") or "").strip()
    errors = list(search.get("errors") or [])
    try:
        summary = synthesize_target_research(keywords, web_summary)
        return {
            "summary": summary,
            "source": "ai_enriched_web" if web_summary else "ai_research",
            "search_sources": search.get("sources") or [],
            "search_query": search.get("query") or "",
            "search_errors": errors,
            "updated_at": int(time.time()),
        }
    except Exception as exc:
        errors.append(f"ai_research:{str(exc)[:240]}")

    # AI归纳异常时，仍允许经过校验的公开搜索证据形成目标背景研究成果。
    contextual_summary = (
        f"目标对象：{'、'.join(str(item) for item in keywords)}。"
        f"公开检索资料：{web_summary}"
    )
    if web_summary and research_summary_valid(contextual_summary, keywords):
        return {
            "summary": contextual_summary[:3200],
            "source": "validated_web",
            "search_sources": search.get("sources") or [],
            "search_query": search.get("query") or "",
            "search_errors": errors,
            "updated_at": int(time.time()),
        }
    return {
        "summary": "",
        "source": "research_error",
        "search_sources": search.get("sources") or [],
        "search_query": search.get("query") or "",
        "search_errors": errors,
        "updated_at": int(time.time()),
    }


def save_target_research_cache():
    TARGET_RESEARCH_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = TARGET_RESEARCH_CACHE_PATH.with_suffix(f".{threading.get_ident()}.tmp")
    temp.write_text(json.dumps(TARGET_RESEARCH_CACHE, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(TARGET_RESEARCH_CACHE_PATH)


def prefetch_target_research(keywords):
    key = target_research_key(keywords)
    if not key:
        return
    with TARGET_RESEARCH_LOCK:
        cached = TARGET_RESEARCH_CACHE.get(key) or {}
        low_confidence_cache = (
            bool(cached.get("summary"))
            and cached.get("source") == "ai_research"
            and not cached.get("search_sources")
        )
        if key in TARGET_RESEARCH_INFLIGHT:
            return
        if cached.get("summary") and not low_confidence_cache:
            return
        if low_confidence_cache and key in TARGET_RESEARCH_REFRESHED:
            return
        if low_confidence_cache:
            TARGET_RESEARCH_REFRESHED.add(key)
        TARGET_RESEARCH_INFLIGHT.add(key)

    def worker():
        try:
            result = build_target_research(keywords)
            with TARGET_RESEARCH_LOCK:
                TARGET_RESEARCH_CACHE[key] = result
                save_target_research_cache()
        except Exception as exc:
            with TARGET_RESEARCH_LOCK:
                TARGET_RESEARCH_CACHE[key] = {
                    "summary": "",
                    "error": str(exc)[:240],
                    "updated_at": int(time.time()),
                }
        finally:
            with TARGET_RESEARCH_LOCK:
                TARGET_RESEARCH_INFLIGHT.discard(key)

    threading.Thread(target=worker, name=f"target-research-{key[:16]}", daemon=True).start()


def get_target_research(keywords, wait_seconds=0, return_details=False):
    key = target_research_key(keywords)
    with TARGET_RESEARCH_LOCK:
        details = dict(TARGET_RESEARCH_CACHE.get(key) or {})
        summary = str(details.get("summary") or "").strip()
    if not summary:
        prefetch_target_research(keywords)
    if not summary and wait_seconds:
        deadline = time.time() + max(0, float(wait_seconds))
        while time.time() < deadline:
            time.sleep(0.1)
            with TARGET_RESEARCH_LOCK:
                details = dict(TARGET_RESEARCH_CACHE.get(key) or {})
                summary = str(details.get("summary") or "").strip()
                inflight = key in TARGET_RESEARCH_INFLIGHT
            if summary or not inflight:
                break
    if not summary and wait_seconds:
        try:
            details = build_target_research(keywords)
            summary = str(details.get("summary") or "").strip()
            with TARGET_RESEARCH_LOCK:
                TARGET_RESEARCH_CACHE[key] = details
                save_target_research_cache()
        except Exception as exc:
            details = {
                "summary": "",
                "source": "research_error",
                "search_errors": [str(exc)[:240]],
                "updated_at": int(time.time()),
            }
    if return_details:
        return details
    return summary


def research_clues(research_text):
    text = str(research_text or "")
    return [
        term for term in (
            "中外合作办学", "本科", "公办", "民办", "财经", "管理", "商科", "国际化",
            "校企合作", "产教融合", "应用型", "全日制", "本地服务", "一站式交付",
            "真实案例", "亲子", "康养", "交通便利", "可邮寄",
        )
        if term in text
    ][:5]


def infer_target_profile(keywords, question="", platform_background=""):
    """给追问模型看的内部画像：帮助它靠近目标，但追问不能直接说目标名。"""
    raw_text = " ".join([str(item or "") for item in (keywords or [])])
    q_text = str(question or "")
    background_text = str(platform_background or "")
    joined = raw_text + " " + q_text + " " + background_text

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

    safe_target_clues = []
    if category == "餐饮门店/食品品牌":
        for term in ("辣子鸡", "酸汤鱼", "火锅", "烙锅", "烧烤", "小吃", "特产"):
            if term in joined:
                safe_target_clues.append(f"{term}品类")
        for term, clue in (
            ("干香", "干香口味"),
            ("糯香", "糯香口味"),
            ("酸辣", "酸辣口味"),
            ("麻辣", "麻辣口味"),
        ):
            if term in joined:
                safe_target_clues.append(clue)
        if re.search(r"老街|老字号|百年|传承|祖传", raw_text):
            safe_target_clues.append("经营时间较长且有传统制作传承")
        if re.search(r"真空|邮寄|包装|伴手礼", joined):
            safe_target_clues.append("支持包装携带或邮寄")
        for term, clue in (
            ("无水慢煸", "无水慢煸做法"),
            ("糍粑辣椒", "使用贵州糍粑辣椒"),
            ("香大于辣", "香味突出而非单纯追求辣度"),
            ("外焦里嫩", "鸡肉外焦里嫩且有嚼劲"),
            ("现杀", "鲜鸡现做"),
        ):
            if term in background_text:
                safe_target_clues.append(clue)
    elif category == "院校/教育机构":
        for term in ("本科", "专科", "财经", "商科", "管理", "职业技术", "中外合作"):
            if term in joined:
                safe_target_clues.append(f"{term}方向")
    safe_target_clues = list(dict.fromkeys(safe_target_clues))[:5]

    return {
        "target_keywords_internal": keywords,
        "category": category,
        "regions": regions,
        "category_clues": category_clues,
        "scenario_clues": scenario_clues,
        "safe_target_clues": safe_target_clues,
        "guidance": "目标画像和原始问题意图优先于上一轮回答。追问应主动增加与目标对象相同的地区、类型、场景和服务能力约束，让被测AI更可能自然列出目标对象。",
    }


def extract_answer_focus(answer_text, keywords, original_question=""):
    """提取当前窗口真实回答中的一个短焦点，供动态兜底追问引用。"""
    safe_answer = redact_forbidden_terms(compact_for_prompt(answer_text, 2400), keywords)
    chunks = [
        re.sub(r"^[\s\d一二三四五六七八九十、.．）)（(：:·•\-]+", "", item).strip()
        for item in re.split(r"[\n。！？!?；;]+", safe_answer)
    ]
    chunks = [
        item for item in chunks
        if 8 <= len(item) <= 90
        and not re.search(r"^(来源|参考|搜索全网|调用工具|免责声明)", item)
    ]
    if not chunks:
        return redact_forbidden_terms(compact_for_prompt(original_question, 48), keywords)

    focus_terms = (
        "推荐", "遗漏", "补充", "院校", "专业", "征集", "录取", "滑档", "本科", "专科",
        "地区", "类型", "选择", "候选", "公司", "服务", "案例", "酒店", "餐厅", "医院",
        "景区", "产品", "平台", "价格", "能力", "条件", "名单",
    )
    ranked = sorted(
        enumerate(chunks),
        key=lambda pair: (
            sum(1 for term in focus_terms if term in pair[1]),
            pair[0],
        ),
        reverse=True,
    )
    focus = ranked[0][1]
    return focus if len(focus) <= 54 else focus[:54].rstrip("，、：: ") + "等内容"


def infer_original_question_focus(original_question):
    text = str(original_question or "")
    patterns = [
        (r"多少分|\d+\s*分|分数|位次", "分数和位次对应的录取选择"),
        (r"什么时候|时间|几号|开始", "征集志愿时间、批次顺序和可填报窗口"),
        (r"怎么填|如何填|注意什么", "填报规则、服从调剂和专业限制"),
        (r"哪些专业|专业.*选择", "征集志愿中的专业选择"),
        (r"哪些学校|哪些院校|院校.*选择", "符合条件的院校选择"),
        (r"成功率|概率|机会大吗", "补录成功率、分数匹配和缺额变化"),
        (r"复读还是|复读.*征集|征集.*复读", "征集志愿与复读之间的风险比较"),
        (r"下一批次|后面.*批次", "本科征集结束后的批次衔接"),
        (r"公办本科", "保住公办本科层次和可接受专业"),
        (r"好学校|学校好吗", "院校层次、专业质量和录取把握"),
        (r"还有本科|读本科|本科录取", "保住本科层次的补救路径"),
        (r"升学途径|哪些路", "统招补录之外的升学路径"),
        (r"没录取|怎么办|补救", "未录取后的补救顺序"),
    ]
    for pattern, focus in patterns:
        if re.search(pattern, text):
            return focus
    compact = re.sub(r"[？?。！!\s]+", "", text)
    return compact[:36] or "当前选择条件"


def infer_answer_angle(answer_text, category, followup_count=0):
    """把真实回答压缩成自然追问角度，不在发出的问题中出现“上一轮回答”等元话术。"""
    text = normalize_text(answer_text)
    category_patterns = {
        "院校/教育机构": [
            (r"降分|降分录取|低于批次线", "征集志愿可能降分及分数匹配"),
            (r"服从调剂|调剂", "服从调剂后的专业适配"),
            (r"专业限制|体检|单科成绩", "专业限制和报考条件"),
            (r"时间|小时|窗口期|考试院", "征集公告时间和填报窗口"),
            (r"征集志愿|缺额|补录", "本科征集志愿的缺额计划"),
            (r"高职|专科|专升本", "高职专科与专升本衔接"),
            (r"民办|独立学院", "民办本科的学费与培养方向"),
            (r"中外合作|国际|联合学院", "中外合作培养和专业方向"),
            (r"公办", "公办院校层次与冷门专业"),
            (r"复读", "复读成本和再次报考风险"),
            (r"滑档|退档", "滑档后的同批次补救选择"),
        ],
        "公司/服务商": [
            (r"案例|客户|项目", "真实案例和同类项目经验"),
            (r"交付|全流程|一站式", "完整交付能力"),
            (r"本地|上门|地区", "本地服务便利性"),
            (r"价格|报价|预算", "预算与服务范围"),
        ],
        "酒店/住宿": [
            (r"交通|地铁|位置", "交通位置与出行便利"),
            (r"家庭|亲子|老人", "家庭入住体验"),
            (r"价格|预算|性价比", "价格与性价比"),
        ],
        "医疗机构": [
            (r"专家|医生|团队", "专家团队与诊疗经验"),
            (r"设备|技术|手术", "设备技术与治疗能力"),
            (r"预约|挂号|排队", "预约和就诊便利性"),
        ],
        "文旅/景区": [
            (r"交通|路线|自驾", "交通路线与游玩顺序"),
            (r"亲子|老人|家庭", "家庭出游适配"),
            (r"门票|价格|预算", "门票与整体预算"),
        ],
        "餐饮门店/食品品牌": [
            (r"邮寄|真空|包装", "包装与异地邮寄"),
            (r"本地|门店|地址", "本地门店与购买便利"),
            (r"口味|招牌|特色", "招牌特色与口味"),
        ],
        "产品/软件/平台": [
            (r"功能|能力|支持", "核心功能与适用场景"),
            (r"价格|收费|套餐", "价格套餐与使用成本"),
            (r"案例|客户|落地", "真实落地案例"),
        ],
    }
    matched_angles = []
    for pattern, angle in category_patterns.get(category, []):
        if re.search(pattern, text):
            matched_angles.append(angle)
    if not matched_angles:
        return ""
    try:
        round_index = int(followup_count or 0)
    except Exception:
        round_index = 0
    checksum = sum((index + 1) * ord(char) for index, char in enumerate(text[:700]))
    return matched_angles[(checksum + round_index) % len(matched_angles)]


FOLLOWUP_ASPECTS = {
    "院校/教育机构": [
        ("具体选择", r"具体(?:院校|学校|专业)|(?:院校|学校|专业)名单|哪些.*(?:院校|学校|专业)|推荐|例如|包括|可选择", "具体院校、专业和适配理由"),
        ("分数资格", r"多少分|\d+分|分数|位次|资格|省控线|批次线|降分|报考条件", "分数、位次和报考资格"),
        ("时间批次", r"时间|日期|几号|批次|窗口|截止|考试院", "时间节点和批次衔接"),
        ("填报规则", r"填报|志愿|调剂|顺序|规则|系统|提交", "填报规则、顺序和调剂限制"),
        ("录取风险", r"滑档|退档|风险|概率|成功率|录取把握|缺额", "录取把握和可能风险"),
        ("费用条件", r"学费|费用|收费|住宿费|预算|经济", "费用和附加条件"),
        ("培养就业", r"培养|课程|就业|升学|考研|专升本|认可度", "培养方式、就业和后续升学"),
        ("替代路径", r"复读|专科|下一批|补救|其他途径|替代", "未录取后的替代和补救路径"),
    ],
    "公司/服务商": [
        ("具体选择", r"具体(?:公司|服务商|团队)|(?:公司|服务商|团队)名单|哪些.*(?:公司|服务商|团队)|推荐|例如|包括", "具体服务商和适配理由"),
        ("交付能力", r"交付|流程|方案|实施|落地|一站式", "交付范围和实施能力"),
        ("案例经验", r"案例|客户|项目|经验|同类", "同类案例和实际经验"),
        ("本地服务", r"本地|上门|地区|响应|售后", "本地响应和售后便利性"),
        ("价格条件", r"价格|报价|收费|预算|合同", "价格、合同和服务边界"),
        ("风险比较", r"风险|缺点|限制|比较|差异|避坑", "限制条件和选择风险"),
    ],
    "产品/软件/平台": [
        ("具体选择", r"具体(?:产品|软件|平台|工具)|(?:产品|软件|平台|工具)名单|哪些.*(?:产品|软件|平台|工具)|推荐|例如|包括", "具体产品和适配理由"),
        ("核心功能", r"功能|能力|支持|场景|集成", "核心功能和适用场景"),
        ("使用成本", r"价格|收费|套餐|成本|预算", "使用成本和套餐限制"),
        ("落地案例", r"案例|客户|落地|项目|部署", "真实落地案例"),
        ("限制风险", r"限制|风险|缺点|安全|稳定", "限制条件和使用风险"),
    ],
    "餐饮门店/食品品牌": [
        ("具体选择", r"(?:餐厅|饭店|门店|店铺|品牌|老字号).{0,10}(?:名称|名单|推荐)|具体(?:餐厅|饭店|门店|店铺|品牌)", "具体门店、品牌和招牌特色"),
        ("品类口味", r"口味|干香|糯香|酸辣|麻辣|招牌|特色菜|品类", "品类、口味和招牌特色"),
        ("本地口碑", r"本地人|老字号|口碑|评价|排队|回头客", "本地口碑和真实用餐体验"),
        ("购买携带", r"包装|真空|邮寄|携带|保存|运输|伴手礼|特产", "购买、包装、保存和携带条件"),
        ("价格体验", r"价格|人均|性价比|份量|环境|服务", "价格、份量和整体体验"),
    ],
}

GENERIC_FOLLOWUP_ASPECTS = [
    ("具体选择", r"名称|名单|推荐|选择|候选", "具体候选项和适配理由"),
    ("适用条件", r"条件|要求|资格|适合|限制", "适用条件和限制"),
    ("实际能力", r"能力|服务|功能|体验|效果", "实际能力和使用效果"),
    ("成本价格", r"价格|费用|收费|预算|成本", "价格和整体成本"),
    ("风险比较", r"风险|缺点|比较|差异|避坑", "差异、限制和选择风险"),
]


def followup_aspects_for(category):
    return FOLLOWUP_ASPECTS.get(category) or GENERIC_FOLLOWUP_ASPECTS


def prompt_similarity(left, right):
    """字符序列和三元组共同判重，避免只换几个连接词的伪差异。"""
    left_text = normalize_text(left)
    right_text = normalize_text(right)
    if not left_text or not right_text:
        return 0.0
    sequence_score = SequenceMatcher(None, left_text, right_text).ratio()

    def ngrams(text, size=3):
        if len(text) <= size:
            return {text}
        return {text[index:index + size] for index in range(len(text) - size + 1)}

    left_grams = ngrams(left_text)
    right_grams = ngrams(right_text)
    union = left_grams | right_grams
    jaccard_score = len(left_grams & right_grams) / len(union) if union else 0.0
    return max(sequence_score, jaccard_score)


def infer_followup_state(original_question, real_answer, conversation, category):
    """识别当前回答已覆盖内容、尚未回答的缺口和本任务已经追问过的角度。"""
    aspects = followup_aspects_for(category)
    answer = normalize_text(real_answer)
    original = normalize_text(original_question)
    history_prompts = []
    for item in conversation or []:
        if item.get("role") != "user":
            continue
        content = str(item.get("content") or "").strip()
        if content and normalize_text(content) != original:
            history_prompts.append(content)

    answered = []
    used = []
    for name, pattern, description in aspects:
        if re.search(pattern, answer):
            answered.append({"angle": name, "description": description})
        if any(re.search(pattern, normalize_text(prompt)) for prompt in history_prompts):
            used.append(name)

    unresolved = [
        {"angle": name, "description": description}
        for name, _pattern, description in aspects
        if name not in {item["angle"] for item in answered} and name not in used
    ]
    if not unresolved:
        unresolved = [
            {"angle": name, "description": description}
            for name, _pattern, description in aspects
            if name not in used
        ]
    if not unresolved:
        unresolved = [{"angle": "补充遗漏", "description": "尚未出现的具体选择及其关键差异"}]

    # 首次问题明确关心的角度优先，但同一角度已经回答或追问过时不会重复使用。
    original_priority = [
        name for name, pattern, _description in aspects
        if re.search(pattern, original)
    ]
    unresolved.sort(key=lambda item: (item["angle"] not in original_priority, original_priority.index(item["angle"]) if item["angle"] in original_priority else 999))
    return {
        "answered_aspects": answered,
        "unresolved_gaps": unresolved,
        "original_bridge_angles": original_priority,
        "used_angles": list(dict.fromkeys(used)),
        "previous_followups": history_prompts[-5:],
    }


def build_gap_prompt(question_focus, gap, category, region_text, variant, safe_target_clues=None):
    angle = gap["angle"]
    location = f"{region_text}范围内" if region_text else "符合这些条件的范围内"
    target_filter = "、".join(
        str(item).strip() for item in (safe_target_clues or []) if str(item).strip()
    )
    food_focus = target_filter or question_focus
    education_prompts = {
        "具体选择": [
            f"{location}还有哪些适合{question_focus}的具体院校或专业？请列出名称并分别说明适配理由。",
            f"针对{question_focus}，请补充{location}容易遗漏的院校和专业，只列具体名称及关键理由。",
            f"{location}可重点比较哪些尚未提到的院校或专业，才能更贴近{question_focus}？",
        ],
        "分数资格": [
            f"判断{question_focus}时，考生应怎样结合分数、位次和批次线确认报考资格？",
            f"{question_focus}对分数和位次分别有什么要求，哪些资格限制最容易导致不能填报？",
            f"不同分数段的考生面对{question_focus}应如何判断机会，请给出可操作的位次和资格标准。",
        ],
        "时间批次": [
            f"{question_focus}通常在哪些时间节点发布和填报，错过后会怎样衔接下一批次？",
            f"请梳理{question_focus}从公告发布到录取结束的时间顺序，并指出必须及时完成的步骤。",
            f"考试院公布{question_focus}后，考生需要在多长时间内完成哪些操作？",
        ],
        "填报规则": [
            f"{question_focus}具体怎样填报，志愿顺序、专业限制和服从调剂会怎样影响结果？",
            f"参与{question_focus}时应遵守哪些填报规则，哪些操作最容易造成无效志愿或退档？",
            f"请说明{question_focus}的志愿数量、排序方式和调剂规则，考生应怎样安排更稳妥？",
        ],
        "录取风险": [
            f"{question_focus}的录取把握主要受哪些因素影响，怎样降低再次滑档或退档的风险？",
            f"哪些情况会让{question_focus}看似有机会却最终未录取，考生应提前核对什么？",
            f"请按影响大小分析{question_focus}中的缺额变化、分数竞争和专业限制风险。",
        ],
        "费用条件": [
            f"选择{question_focus}涉及哪些学费、住宿费或额外费用，哪些项目需要提前确认？",
            f"{question_focus}中不同培养类型的费用差异有多大，家庭预算应怎样评估？",
            f"除录取条件外，{question_focus}还要重点核对哪些收费和经济负担？",
        ],
        "培养就业": [
            f"{question_focus}中的不同专业在培养方式、就业方向和后续升学上有什么实际差异？",
            f"如果不仅看能否录取，{question_focus}还应怎样比较专业培养质量和毕业去向？",
            f"请从课程培养、就业适配和继续升学三个方面比较{question_focus}的长期影响。",
        ],
        "替代路径": [
            f"如果{question_focus}仍未录取，接下来有哪些批次或升学路径可以衔接，各自代价是什么？",
            f"{question_focus}失败后，继续等后续批次、读专科再升本和复读分别适合什么情况？",
            f"请按时间顺序说明{question_focus}未成功后的补救方案，并比较风险和最终学历路径。",
        ],
    }
    food_prompts = {
        "具体选择": [
            f"{location}还有哪些同时符合{food_focus}的具体门店或品牌？请列出名称和招牌特色。",
            f"请补充{location}尚未提到、同时具备{food_focus}特征的具体门店，并说明各自特色。",
            f"{location}还可以比较哪些同时符合{food_focus}的具体店铺或品牌？请优先列出最典型的名称。",
        ],
        "品类口味": [
            f"如果限定为{food_focus}，{location}还有哪些具体门店最具代表性？",
            f"按{food_focus}筛选，{location}还有哪些尚未提到的具体店铺值得补充？",
            f"{location}哪些具体门店同时符合{food_focus}，并拥有有辨识度的招牌做法？",
        ],
        "本地口碑": [
            f"如果同时看重本地人口碑和{food_focus}，{location}还有哪些具体门店值得补充？",
            f"{location}有哪些本地人常去、符合{food_focus}但刚才没有列出的具体店铺？",
            f"按本地口碑与{food_focus}共同筛选，{location}还有哪些具体门店？",
        ],
        "购买携带": [
            f"在符合{food_focus}的前提下，{location}还有哪些方便包装携带的具体门店或品牌？",
            f"{location}有哪些具体店铺同时具备{food_focus}并方便保存运输？",
            f"按包装携带条件筛选，{location}还有哪些符合{food_focus}的具体品牌或门店？",
        ],
        "价格体验": [
            f"在符合{food_focus}的门店中，{location}还有哪些价格与体验更均衡的具体选择？",
            f"{location}有哪些兼具{food_focus}和较好性价比、但刚才未提到的具体店铺？",
            f"按价格和整体体验筛选，{location}还可以补充哪些符合{food_focus}的具体门店？",
        ],
    }
    generic_prompts = {
        "具体选择": f"{location}还有哪些具体候选项真正符合{question_focus}？请列出名称和适配理由。",
        "适用条件": f"要满足{question_focus}，应重点核对哪些适用条件和限制？",
        "实际能力": f"围绕{question_focus}，哪些实际能力和使用效果最值得验证？",
        "成本价格": f"解决{question_focus}需要承担哪些费用，怎样比较整体成本？",
        "风险比较": f"面对{question_focus}，不同选择的关键差异和潜在风险分别是什么？",
        "补充遗漏": f"{location}还有哪些容易遗漏但符合{question_focus}的具体选择？请给出名称和理由。",
    }
    if category == "院校/教育机构" and angle in education_prompts:
        return education_prompts[angle][variant % len(education_prompts[angle])]
    if category == "餐饮门店/食品品牌" and angle in food_prompts:
        return food_prompts[angle][variant % len(food_prompts[angle])]
    return generic_prompts.get(
        angle,
        f"围绕{question_focus}，还需要补充哪些关于{gap['description']}的关键信息？",
    )


def build_contextual_fallback_followup(
    original_question,
    previous_question,
    real_answer,
    target_profile,
    target_research,
    followup_count,
    keywords,
    conversation=None,
    platform="",
):
    """AI接口不可用时，按真实回答的未解决缺口生成不重复追问。"""
    focus = extract_answer_focus(real_answer, keywords, original_question)
    regions = [str(item).strip() for item in (target_profile.get("regions") or []) if str(item).strip()]
    region_text = "、".join(regions[:2])
    category = str(target_profile.get("category") or "候选对象")
    question_focus = infer_original_question_focus(original_question)
    state = infer_followup_state(original_question, real_answer, conversation or [], category)
    answer_seed = sum(
        (index + 1) * ord(char)
        for index, char in enumerate(normalize_text(real_answer + platform)[:1200])
    )
    gaps = state["unresolved_gaps"]

    prompt = ""
    selected_gap = gaps[0]
    best_similarity = 1.0
    for gap_index, gap in enumerate(gaps):
        for variant_index in range(3):
            variant = (answer_seed + gap_index + variant_index) % 3
            candidate = build_gap_prompt(
                question_focus,
                gap,
                category,
                region_text,
                variant,
                target_profile.get("safe_target_clues") or [],
            )
            similarity = max(
                [prompt_similarity(candidate, old_prompt) for old_prompt in state["previous_followups"]] or [0.0]
            )
            if similarity < best_similarity:
                prompt, selected_gap, best_similarity = candidate, gap, similarity
            if similarity < 0.68:
                prompt, selected_gap, best_similarity = candidate, gap, similarity
                break
        if best_similarity < 0.68:
            break

    prompt = redact_forbidden_terms(re.sub(r"\s+", "", prompt), keywords)
    if len(prompt) > 160:
        prompt = prompt[:157].rstrip("，、；;：: ") + "？"
    if not prompt.endswith(("？", "?")):
        prompt = prompt.rstrip("。！？!?") + "？"
    state["selected_gap"] = selected_gap
    state["history_max_similarity"] = round(best_similarity, 4)
    return prompt, focus, state


def followup_strategy(followup_count):
    try:
        count = int(followup_count or 0)
    except Exception:
        count = 0
    if count <= 0:
        return "第一轮追问：从首次问题的真实目的出发，选择当前回答尚未解决的最关键缺口。"
    if count == 1:
        return "第二轮追问：避开第一轮使用过的角度，从当前新回答里寻找下一个未解决内容。"
    return "第三轮追问：禁止复用历史句式和角度，只追问仍未覆盖且最影响原始目的的内容。"


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
        RUNTIME_CONFIG.get("enabled")
        and RUNTIME_CONFIG.get("api_url")
        and RUNTIME_CONFIG.get("api_key")
        and RUNTIME_CONFIG.get("model")
    )


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
    previous_question = str(ctx.get("latest_question") or ctx.get("question") or question or "").strip()
    original_question = str(ctx.get("original_question") or "").strip()
    real_answer = str(ctx.get("answer") or answer_text or "").strip()
    real_platform = str(ctx.get("platform") or platform or "").strip()
    task_id = str(ctx.get("task_id") or "").strip()
    platform_target_context = str(ctx.get("target_platform_context") or "").strip()
    conversation = [normalize_conversation_item(item) for item in (ctx.get("conversation") or [])]
    conversation = [item for item in conversation if item]
    if not conversation and previous_question and real_answer:
        conversation = [{"role": "user", "content": previous_question}, {"role": "assistant", "content": real_answer}]
    if not original_question:
        original_question = next(
            (item["content"] for item in conversation if item.get("role") == "user" and item.get("content")),
            previous_question,
        )
    return original_question, previous_question, real_answer, real_platform, conversation, task_id, platform_target_context


def generate_followup(question, answer_text, keywords, followup_count=0, platform=""):
    keywords = [str(item).strip() for item in (keywords or []) if str(item).strip()]
    original_question, previous_question, real_answer, real_platform, conversation, task_id, platform_target_context = parse_followup_context(
        question, answer_text, platform
    )
    if not keywords:
        return {"ok": False, "prompt": "", "source": "error", "reason": "缺少目标关键词", "real_answer_valid": False, "conversation_turns": len(conversation), "task_id": task_id}
    if len(normalize_text(real_answer)) < 20:
        return {"ok": False, "prompt": "", "source": "error", "reason": "没有获取到足够长度的平台真实回复，停止追问", "real_answer_valid": False, "conversation_turns": len(conversation), "task_id": task_id}
    forbidden_terms = sorted({alias for keyword in keywords for alias in keyword_aliases(keyword)}, key=len, reverse=True)
    safe_conversation = []
    normalized_real_answer = normalize_text(real_answer)
    for item in conversation[-6:]:
        if item["role"] == "assistant" and normalize_text(item["content"]) == normalized_real_answer:
            continue
        safe_conversation.append({"role": item["role"], "content": redact_forbidden_terms(compact_for_prompt(item["content"], 900), keywords)})

    # 直接模式：每个窗口只使用自己的 Excel 问题、真实回答、对话历史和内部目标词。
    # 不等待网页背景搜索，也不把其他窗口的内容带入本次请求。
    target_profile = infer_target_profile(keywords, original_question, platform_target_context)
    target_research = compact_for_prompt(platform_target_context, 2600)
    target_research_details = {
        "source": "platform_prewarm_cache" if target_research else "direct_question_answer_keywords",
        "search_sources": ["doubao", "yuanbao", "qianwen"] if target_research else [],
    }
    fallback_prompt, answer_focus, followup_state = build_contextual_fallback_followup(
        original_question=original_question,
        previous_question=previous_question,
        real_answer=real_answer,
        target_profile=target_profile,
        target_research=target_research,
        followup_count=followup_count,
        keywords=keywords,
        conversation=conversation,
        platform=real_platform,
    )
    if not followup_config_ready():
        return {
            "ok": False,
            "prompt": "",
            "source": "ai_required_error",
            "reason": "AI追问接口未启用或配置不完整；已停止追问，未发送任何规则模板",
            "real_answer_valid": True,
            "conversation_turns": len(conversation),
            "used_structured_context": True,
            "answer_focus": answer_focus,
            "selected_gap": followup_state.get("selected_gap"),
            "answered_aspects": followup_state.get("answered_aspects"),
            "used_angles": followup_state.get("used_angles"),
            "history_max_similarity": followup_state.get("history_max_similarity"),
            "task_id": task_id,
        }
    structured_input = {
        "original_question": redact_forbidden_terms(compact_for_prompt(original_question, 900), keywords),
        "latest_question": redact_forbidden_terms(compact_for_prompt(previous_question, 900), keywords),
        "latest_answer": redact_forbidden_terms(compact_for_prompt(real_answer, 1800), keywords),
        "platform": real_platform,
        "conversation": safe_conversation,
        "followup_count": followup_count,
        "forbidden_terms": forbidden_terms,
        "dynamic_target_background_internal": {
            "cache_scope": target_research_key(keywords),
            "target_keywords_internal": keywords,
            "search_summary": compact_for_prompt(target_research, 1800),
            "research_source": target_research_details.get("source") or "cache",
            "search_sources": target_research_details.get("search_sources") or [],
            "category_hint": target_profile.get("category"),
        },
        "target_definition": {
            "actual_target_names_internal": keywords,
            "meaning": "这些学校名、品牌名、商家名或机构名才是必须争取出现在被测平台回答中的目标；分数、位次、费用、专业、地区、能力和场景都只是引导筛选条件，绝不是目标关键词。",
        },
        "bridge_context": {
            "original_decision_focus": infer_original_question_focus(original_question),
            "target_entity_category": target_profile.get("category"),
            "instruction": "把original_decision_focus和当前回答缺口作为筛选维度，引导被测平台列出target_entity_category的具体对象；筛选维度是桥梁，列出目标类别对象才是结果。",
        },
        "answered_aspects": followup_state.get("answered_aspects"),
        "unresolved_gaps": followup_state.get("unresolved_gaps"),
        "original_bridge_angles": followup_state.get("original_bridge_angles"),
        "used_angles": followup_state.get("used_angles"),
        "previous_followups": [
            redact_forbidden_terms(compact_for_prompt(item, 500), keywords)
            for item in followup_state.get("previous_followups") or []
        ],
        "priority_order": [
            "1. 内部目标：让被测平台更可能自然列出 dynamic_target_background_internal.target_keywords_internal 中的对象，这是候选问题评分的最高目标",
            "2. original_question 与 bridge_context.original_decision_focus：提供通向目标类别的真实筛选维度，追问不能偏离用户关心的分数、费用、专业、能力等方面",
            "3. latest_answer 与 unresolved_gaps：决定怎样自然承接本窗口回答以及避开什么重复内容",
        ],
        "strategy": followup_strategy(followup_count),
        "task": "只使用本任务 dynamic_target_background_internal.search_summary 动态理解当前目标对象及其可能涉及的方面，不得套用固定特征词表。把原问题关心的方面和当前回答缺口作为桥梁条件，内部生成3个会促使被测平台列出target_entity_category具体名称的候选并评分，只输出最可能让当前目标对象自然上榜的一句实际追问。最终追问绝不能出现目标对象名称、简称、别名或明显变体。",
        "candidate_scoring": {
            "target_listing_likelihood": "50分：不说目标名称，仅靠预埋背景特征能否让平台自然列出目标对象",
            "original_question_relevance": "25分：是否把首次问题关心的方面转化为筛选目标类别对象的条件",
            "actual_answer_continuity": "15分：是否从该窗口实际回答的未解决内容自然切入",
            "naturalness_and_novelty": "10分：是否像真实用户且不重复历史追问",
        },
        "rules": [
            "严格遵守 priority_order；每个任务只能使用与自己目标关键词对应的动态搜索背景，禁止借用其他任务或其他目标的背景。",
            "严格区分target_definition.actual_target_names_internal和桥梁条件：前者才是目标对象名称，后者只能帮助平台检索或筛选目标对象。",
            "不能套用贵州、本科、财经、公司、案例等固定预设；只有当前search_summary真实支持的特征才能用于生成。",
            "必须围绕 original_question 继续问，不能换话题，不能越问越宽泛。",
            "先识别 original_question 真正关心的方面；例如关心分数时，要把分数或位次变成筛选学校的条件，而不是只抽象询问分数规则。",
            "最终问题必须自然邀请平台列出、补充或比较 target_entity_category 的具体名称；unresolved_gaps只是选择引导角度，不是最终输出目的。",
            "先识别 latest_answer 已经明确回答的内容，再选择一个未重复的桥梁角度。",
            "answered_aspects不能再次作为知识点重复解释，但如果它同时属于original_bridge_angles，可以继续作为筛选目标类别对象的条件。",
            "禁止重复used_angles中已经发出过的追问方向。",
            "AI必须从当前search_summary自行提炼目标对象独有或强相关的事实，再选择与原始问题和实际回答衔接自然的事实用于引导。",
            "不能机械复述搜索摘要；只使用最能提高当前目标对象出现概率、同时符合用户语境的少量事实。",
            "新问题与 previous_followups 不能只是替换连接词，语义和句式都应有明显差异。",
            "不同平台必须以各自 latest_answer 为依据，不能复用其他平台的追问内容。",
            "追问要像普通用户自然追问，不能暴露测试、命中、目标词、关键词、GEO检测等意图。",
            "最终只输出自然问题本身，禁止出现“根据上一轮回答、结合你刚才的回答、前面提到、继续核对、原问题”等说明生成过程的元话术。",
            "不要出现任何forbidden_terms中的词或其明显变体。",
            "不能直接给出目标关键词、目标对象名称、简称或别名。",
            "即使桥梁角度是时间、资格、费用或风险，也要把它转化为筛选目标类别具体对象的条件，而不是停留在规则解释。",
            "如果当前回答已经列了很多对象，就要求补充未出现、但更符合桥梁条件的新对象，或按该条件重新比较具体对象。",
            "每轮必须换用一个尚未回答且未追问过的角度，不能为了增加约束而偏离原始问题。",
            "不能输出代码、SQL、JSON、HTML、操作步骤、列表或多条问题。",
            "只能问一个方向，40到120个中文字符。",
        ],
        "bad_examples": [
            "还有别的吗？",
            "能不能再详细介绍一下？",
            "请继续补充更多选择。",
        ],
        "good_pattern": "原问题关心某分数能否上本科、目标属于学校时，应追问“这个分数和位次下，当地还有哪些符合某层次及相关专业条件的院校可以通过征集志愿考虑”，用分数作为桥梁引出学校名单，但绝不写目标校名。",
        "return_schema": {"prompt": "下一轮追问文本", "intent": "必须原样填写本次选择的unresolved_gaps.angle"},
    }

    compact_ai_input = {
        "task_id": task_id,
        "original_question": redact_forbidden_terms(compact_for_prompt(original_question, 600), keywords),
        "latest_question": redact_forbidden_terms(compact_for_prompt(previous_question, 500), keywords),
        "latest_answer": redact_forbidden_terms(compact_for_prompt(real_answer, 1400), keywords),
        "platform": real_platform,
        "followup_count": followup_count,
        "target_keywords_internal": keywords,
        "target_category": target_profile.get("category"),
        "target_regions": target_profile.get("regions") or [],
        "safe_target_clues": target_profile.get("safe_target_clues") or [],
        "target_platform_background_internal": target_research,
        "conversation": safe_conversation[-4:],
        "unresolved_gaps": followup_state.get("unresolved_gaps") or [],
        "used_angles": followup_state.get("used_angles") or [],
        "previous_followups": [
            redact_forbidden_terms(compact_for_prompt(item, 300), keywords)
            for item in followup_state.get("previous_followups") or []
        ],
        "rules": [
            "target_keywords_internal只用于内部确定引导方向，输出中禁止出现其全称、简称或别名。",
            "必须承接当前Excel原问题和该平台最新真实回答，不能换话题。",
            "追问要提高目标对象在下一轮回答中自然出现的可能性，但不能直接点名目标。",
            "优先把safe_target_clues中的品类、口味、地域或传承属性组合成筛选条件，不能只问泛泛的更多推荐。",
            "target_platform_background_internal来自独立预搜索窗口，只用于提炼目标对象的非名称特征；不得在追问中复制目标名称。",
            "选择一个尚未回答、也未追问过的角度，引导平台补充或比较具体名称。",
            "不同平台依据各自回答生成，不得复用其他窗口内容。",
            "只输出一句40到120字的自然问题，不解释生成过程。",
        ],
        "return_schema": {
            "prompt": "追问文本",
            "intent": "必须原样填写unresolved_gaps中的一个angle",
        },
    }
    payload = {
        "model": RUNTIME_CONFIG.get("model"),
        "messages": [
            {"role": "system", "content": "你是GEO追问生成器。只根据本请求的Excel问题、当前窗口真实回答和内部目标关键词生成一句自然追问。追问应提高目标对象在下一轮回答中自然出现的概率，但绝不能出现目标名称、简称、别名或测试意图。不同task_id和platform必须独立处理。只返回严格JSON。"},
            {"role": "user", "content": json.dumps(compact_ai_input, ensure_ascii=False)},
        ],
        "temperature": 0.38,
        "max_tokens": 220,
        "response_format": {"type": "json_object"},
    }

    runtime_timeout = int(RUNTIME_CONFIG.get("timeout_seconds") or AI_JUDGE_TIMEOUT_SECONDS)
    followup_timeout = max(4, min(QUICK_FOLLOWUP_TIMEOUT_SECONDS, runtime_timeout))
    attempt_errors = []

    for attempt in range(FOLLOWUP_AI_ATTEMPTS):
        attempt_payload = dict(payload)
        attempt_payload["messages"] = [dict(item) for item in payload["messages"]]
        api_mode = "compact_json" if attempt == 0 else "compact_json_retry"
        if attempt > 0:
            previous_error = attempt_errors[-1] if attempt_errors else "上次请求未返回有效结果"
            attempt_payload["messages"][0]["content"] += (
                f"这是第{attempt + 1}次独立生成。上次失败原因：{previous_error[:160]}。"
                "必须重新生成不同的实际问题，并严格返回JSON对象，不要解释，不要包含目标名称。"
            )
        try:
            # 每个平台窗口独立并行生成；单个请求超时后只让本窗口走本地兜底，
            # 不阻塞或取消其他窗口的追问。
            body = call_chat_completions(attempt_payload, timeout_seconds=followup_timeout)
            content = body["choices"][0]["message"]["content"]
            allowed_angles = {
                str(item.get("angle") or "")
                for item in followup_state.get("unresolved_gaps") or []
                if str(item.get("angle") or "")
            }
            allowed_angles.update(
                str(item or "")
                for item in followup_state.get("original_bridge_angles") or []
                if str(item or "")
            )
            allowed_angles.difference_update(
                str(item or "")
                for item in followup_state.get("used_angles") or []
                if str(item or "")
            )
            prompt, intent = parse_followup_content(content)
            prompt = str(prompt or "").strip()
            if not prompt:
                raise ValueError("AI追问为空")
            if contains_forbidden_keyword(prompt, keywords):
                raise ValueError("AI追问包含目标关键词或别名")
            if re.search(r"根据上一轮|结合你刚才|你刚才(?:提到|回答)|前面(?:提到|回答)|继续核对|原问题", prompt):
                raise ValueError("AI追问包含说明生成过程的元话术")
            if len(prompt) < 20 or len(prompt) > 160 or "\n" in prompt:
                raise ValueError("AI追问长度或格式不合规")
            if intent not in allowed_angles:
                raise ValueError("AI追问未明确选择当前回答的未解决角度")
            max_similarity = max(
                [prompt_similarity(prompt, item) for item in followup_state.get("previous_followups") or []] or [0.0]
            )
            if max_similarity >= 0.68:
                raise ValueError(f"AI追问与历史追问过于相似({max_similarity:.2f})")
            return {
                "ok": True,
                "prompt": prompt,
                "source": "ai",
                "intent": intent,
                "api_mode": api_mode,
                "retry_count": attempt,
                "real_answer_valid": True,
                "conversation_turns": len(conversation),
                "used_structured_context": True,
                "target_directed": True,
                "research_source": target_research_details.get("source") or "cache",
                "research_sources": target_research_details.get("search_sources") or [],
                "task_id": task_id,
                "answer_focus": answer_focus,
                "selected_gap": followup_state.get("selected_gap"),
                "answered_aspects": followup_state.get("answered_aspects"),
                "used_angles": followup_state.get("used_angles"),
                "history_max_similarity": round(max_similarity, 4),
                "target_profile": {
                    "category": target_profile.get("category"),
                    "regions": target_profile.get("regions"),
                    "category_clues": target_profile.get("category_clues"),
                },
            }
        except Exception as exc:
            attempt_errors.append(str(exc))

    fallback_errors = []
    if not fallback_prompt:
        fallback_errors.append("背景兜底追问为空")
    if contains_forbidden_keyword(fallback_prompt, keywords):
        fallback_errors.append("背景兜底追问包含目标关键词或别名")
    if len(fallback_prompt) < 8 or len(fallback_prompt) > 160 or "\n" in fallback_prompt:
        fallback_errors.append("背景兜底追问长度或格式不合规")
    if re.search(r"原问题摘要|上一轮回答摘要|return_schema|forbidden_terms|target_keywords|系统提示|测试目标", fallback_prompt, flags=re.I):
        fallback_errors.append("背景兜底追问包含生成过程元话术")
    fallback_similarity = max(
        [prompt_similarity(fallback_prompt, item) for item in followup_state.get("previous_followups") or []] or [0.0]
    )
    if fallback_similarity >= 0.68:
        fallback_errors.append(f"背景兜底追问与历史追问过于相似({fallback_similarity:.2f})")

    if not fallback_errors:
        selected_gap = followup_state.get("selected_gap") or {}
        return {
            "ok": True,
            "prompt": fallback_prompt,
            "source": "direct_context_fallback",
            "intent": str(selected_gap.get("angle") or "补充遗漏"),
            "api_mode": "local_after_ai_failure",
            "reason": f"AI追问接口失败后根据当前问题、当前回答和目标画像生成安全追问：{'；'.join(attempt_errors)}",
            "retry_count": len(attempt_errors),
            "real_answer_valid": True,
            "conversation_turns": len(conversation),
            "used_structured_context": True,
            "target_directed": True,
            "research_source": target_research_details.get("source") or "cache",
            "research_sources": target_research_details.get("search_sources") or [],
            "task_id": task_id,
            "answer_focus": answer_focus,
            "selected_gap": selected_gap,
            "answered_aspects": followup_state.get("answered_aspects"),
            "used_angles": followup_state.get("used_angles"),
            "history_max_similarity": round(fallback_similarity, 4),
            "target_profile": {
                "category": target_profile.get("category"),
                "regions": target_profile.get("regions"),
                "category_clues": target_profile.get("category_clues"),
            },
        }

    return {
        "ok": False,
        "prompt": "",
        "source": "ai_required_error",
        "reason": (
            f"AI连续{FOLLOWUP_AI_ATTEMPTS}次未生成合规追问，且背景兜底校验失败："
            f"{'；'.join(attempt_errors + fallback_errors)}"
        ),
        "real_answer_valid": True,
        "conversation_turns": len(conversation),
        "used_structured_context": True,
        "answer_focus": answer_focus,
        "selected_gap": followup_state.get("selected_gap"),
        "answered_aspects": followup_state.get("answered_aspects"),
        "used_angles": followup_state.get("used_angles"),
        "history_max_similarity": followup_state.get("history_max_similarity"),
        "task_id": task_id,
    }
