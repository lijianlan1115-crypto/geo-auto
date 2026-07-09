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

    image = Image.open(path).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(overlay)
    width, height = image.size
    x1, y1, x2, y2 = [int(v) for v in bbox]
    pad_x = max(14, int((x2 - x1) * 0.25))
    pad_y = max(12, int((y2 - y1) * 0.9))
    x1 = max(6, x1 - pad_x)
    y1 = max(6, y1 - pad_y)
    x2 = min(width - 6, x2 + pad_x)
    y2 = min(height - 6, y2 + pad_y)

    line_width = max(8, round(min(width, height) * 0.006))
    draw.rectangle([x1, y1, x2, y2], fill=(255, 0, 0, 34))
    for extra in (8, 4, 0):
        draw.rectangle(
            [max(2, x1 - extra), max(2, y1 - extra), min(width - 2, x2 + extra), min(height - 2, y2 + extra)],
            outline=(255, 0, 0, 170 if extra else 255),
            width=max(2, line_width - extra // 2),
        )
    image = Image.alpha_composite(image, overlay).convert("RGB")
    image.save(path)

    return str(path)
