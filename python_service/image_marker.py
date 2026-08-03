# -*- coding: utf-8 -*-
"""
OCR关键词图片标注模块
将OCR返回的坐标直接绘制到原截图，供Excel嵌入使用。
"""

from pathlib import Path


def image_has_red_box(image_path):
    """确认最终 PNG 中存在连续的红色矩形边，避免只凭“已命中”保存无框图。"""
    from PIL import Image

    path = Path(image_path)
    if not path.exists():
        return False
    image = Image.open(path).convert("RGB")
    width, height = image.size
    pixels = image.load()

    red = set()
    for y in range(height):
        for x in range(width):
            # 右上角“命中：...”红色徽标不是关键词拉框，必须排除，
            # 否则会把“只有命中词条、正文没有框”的图片误判为合格。
            if x >= width * 0.55 and y <= height * 0.18:
                continue
            r, g, b = pixels[x, y]
            if r >= 215 and g <= 95 and b <= 95 and r >= g + 100 and r >= b + 100:
                red.add((x, y))
    if len(red) < 500:
        return False

    max_horizontal = 0
    for y in range(height):
        run = 0
        for x in range(width):
            run = run + 1 if (x, y) in red else 0
            max_horizontal = max(max_horizontal, run)
    if max_horizontal < 24:
        return False

    max_vertical = 0
    for x in range(width):
        run = 0
        for y in range(height):
            run = run + 1 if (x, y) in red else 0
            max_vertical = max(max_vertical, run)
    return max_vertical >= 12


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
    # 兜底框只给文字留少量呼吸空间，不能扩到相邻行或整段正文。
    pad_x = max(6, int((x2 - x1) * 0.08))
    pad_y = max(5, int((y2 - y1) * 0.25))
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
