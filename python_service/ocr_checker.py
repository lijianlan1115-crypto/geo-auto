# -*- coding: utf-8 -*-
"""
截图关键词 OCR 检测模块
用于判断截图是否包含目标关键词，并返回文字坐标。
"""


def check_keyword(image_path, keywords):
    """检测图片中是否包含关键词。

    返回:
    {
        matched: bool,
        keyword: str,
        bbox: [x1,y1,x2,y2]
    }
    """
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

    for line in result[0] if result else []:
        text = line[1][0]
        box = line[0]
        for keyword in keywords:
            if keyword and keyword in text:
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                return {
                    "matched": True,
                    "keyword": keyword,
                    "bbox": [min(xs), min(ys), max(xs), max(ys)]
                }

    return {
        "matched": False
    }
