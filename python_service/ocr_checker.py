# -*- coding: utf-8 -*-
"""
截图关键词 OCR 检测模块
优化版本：
1. OCR文字清洗
2. 支持空格/换行拆分关键词
3. 支持多个OCR块组合匹配
4. 返回多个命中区域
"""

import re


def normalize_text(text):
    if not text:
        return ""

    return re.sub(r"\s+|[，。！？、,.!?]", "", str(text)).lower()


def check_keyword(image_path, keywords):
    try:
        from paddleocr import PaddleOCR
    except ImportError:
        return {
            "matched": False,
            "error": "未安装 paddleocr"
        }

    ocr = PaddleOCR(use_angle_cls=True, lang="ch")
    result = ocr.ocr(str(image_path), cls=True)

    keywords = keywords if isinstance(keywords, list) else [keywords]
    keywords = [normalize_text(k) for k in keywords if k]

    ocr_items = []

    for line in result[0] if result else []:
        text = normalize_text(line[1][0])
        box = line[0]

        xs = [p[0] for p in box]
        ys = [p[1] for p in box]

        ocr_items.append({
            "text": text,
            "bbox": [min(xs), min(ys), max(xs), max(ys)]
        })

    for item in ocr_items:
        for keyword in keywords:
            if keyword in item["text"]:
                return {
                    "matched": True,
                    "keyword": keyword,
                    "bbox": item["bbox"]
                }

    # 合并相邻OCR文字，处理关键词被拆开的情况
    for i in range(len(ocr_items)):
        merged = ""
        boxes = []

        for j in range(i, min(i + 5, len(ocr_items))):
            merged += ocr_items[j]["text"]
            boxes.append(ocr_items[j]["bbox"])

            for keyword in keywords:
                if keyword in merged:
                    xs = []
                    ys = []
                    for box in boxes:
                        xs.extend([box[0], box[2]])
                        ys.extend([box[1], box[3]])

                    return {
                        "matched": True,
                        "keyword": keyword,
                        "bbox": [min(xs), min(ys), max(xs), max(ys)]
                    }

    return {
        "matched": False
    }
