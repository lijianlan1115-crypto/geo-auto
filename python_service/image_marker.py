# -*- coding: utf-8 -*-
"""
OCR关键词图片标注模块
将OCR返回的坐标直接绘制到原截图，供Excel嵌入使用。
"""

from pathlib import Path


def mark_image(image_path, bbox):
    from PIL import Image, ImageDraw

    path = Path(image_path)
    if not path.exists() or not bbox:
        return None

    image = Image.open(path)
    draw = ImageDraw.Draw(image)
    draw.rectangle(bbox, outline="red", width=4)
    image.save(path)

    return str(path)
