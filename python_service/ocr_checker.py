# -*- coding: utf-8 -*-
"""
截图关键词 OCR 检测模块（备用）
当浏览器 DOM 定位失败时，使用 Tesseract OCR 对截图进行二次检测。
"""

import re


def normalize_text(text):
    if not text:
        return ""
    return re.sub(r"\s+|[，。！？、,.!?]", "", str(text)).lower()


def expand_bbox_to_text_line(items, bbox):
    if not bbox:
        return bbox
    x1, y1, x2, y2 = bbox
    height = max(1, y2 - y1)
    center_y = (y1 + y2) / 2
    line_boxes = []
    for item in items:
        box = item["bbox"]
        item_center_y = (box[1] + box[3]) / 2
        if abs(item_center_y - center_y) <= max(12, height * 0.85):
            line_boxes.append(box)
    if not line_boxes:
        return bbox
    xs = []
    ys = []
    for box in line_boxes:
        xs.extend([box[0], box[2]])
        ys.extend([box[1], box[3]])
    return [min(xs), min(ys), max(xs), max(ys)]


def check_keyword(image_path, keywords, region_ratio=None):
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return {
            "matched": False,
            "error": "未安装 pytesseract 或 Pillow"
        }

    raw_keywords = keywords if isinstance(keywords, list) else [keywords]
    keyword_items = [
        {"raw": str(item), "normalized": normalize_text(item)}
        for item in raw_keywords
        if item and normalize_text(item)
    ]
    if not keyword_items:
        return {"matched": False}

    try:
        img = Image.open(str(image_path))
        offset_x = 0
        offset_y = 0
        if region_ratio:
            width, height = img.size
            left = max(0, min(width, int(width * float(region_ratio[0]))))
            top = max(0, min(height, int(height * float(region_ratio[1]))))
            right = max(left + 1, min(width, int(width * float(region_ratio[2]))))
            bottom = max(top + 1, min(height, int(height * float(region_ratio[3]))))
            img = img.crop((left, top, right, bottom))
            offset_x = left
            offset_y = top

        last_error = None
        for lang in ("chi_sim+eng", "chi_sim", "eng"):
            try:
                data = pytesseract.image_to_data(img, lang=lang, output_type=pytesseract.Output.DICT)
                break
            except Exception as exc:
                last_error = exc
        else:
            raise last_error
        n_boxes = len(data['text'])

        ocr_items = []
        for i in range(n_boxes):
            text = normalize_text(data['text'][i])
            if not text:
                continue
            x, y, w, h = data['left'][i] + offset_x, data['top'][i] + offset_y, data['width'][i], data['height'][i]
            ocr_items.append({
                "text": text,
                "bbox": [x, y, x + w, y + h]
            })

        for item in ocr_items:
            for keyword in keyword_items:
                if keyword["normalized"] in item["text"]:
                    return {
                        "matched": True,
                        "keyword": keyword["raw"],
                        "bbox": expand_bbox_to_text_line(ocr_items, item["bbox"])
                    }

        # 合并相邻 OCR 文字，处理关键词被拆开的情况
        for i in range(len(ocr_items)):
            merged = ""
            boxes = []
            for j in range(i, min(i + 5, len(ocr_items))):
                merged += ocr_items[j]["text"]
                boxes.append(ocr_items[j]["bbox"])
                for keyword in keyword_items:
                    if keyword["normalized"] in merged:
                        xs = []
                        ys = []
                        for box in boxes:
                            xs.extend([box[0], box[2]])
                            ys.extend([box[1], box[3]])
                        return {
                            "matched": True,
                            "keyword": keyword["raw"],
                            "bbox": expand_bbox_to_text_line(ocr_items, [min(xs), min(ys), max(xs), max(ys)])
                        }

        return {"matched": False}
    except Exception as e:
        return {
            "matched": False,
            "error": str(e)
        }
