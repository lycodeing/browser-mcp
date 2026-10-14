#!/usr/bin/env python3
"""
生成字母 B 图标母版 icon-source.png（深蓝到紫红对角渐变 + 圆角底 + Avenir Next Heavy）
运行：python3 generate_icon_source.py && python3 resize_icons.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
RADIUS = int(SIZE * 0.22)
LETTER = 'B'
FONT_PATH = '/System/Library/Fonts/Avenir Next.ttc'
FONT_INDEX = 8  # Heavy
COLOR_START = (10, 10, 51)
COLOR_END = (163, 25, 212)
LETTER_HEIGHT_RATIO = 0.60

HERE = os.path.dirname(os.path.abspath(__file__))


def gradient(size, c0, c1):
    img = Image.new('RGBA', (size, size))
    px = img.load()
    span = 2 * (size - 1)
    for y in range(size):
        for x in range(size):
            t = (x + y) / span
            px[x, y] = tuple(round(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (255,)
    return img


def main():
    bg = gradient(SIZE, COLOR_START, COLOR_END)
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), RADIUS, fill=255)
    bg.putalpha(mask)

    font_size = int(SIZE * LETTER_HEIGHT_RATIO / 0.72)
    font = ImageFont.truetype(FONT_PATH, font_size, index=FONT_INDEX)
    draw = ImageDraw.Draw(bg)
    l, t, r, b = draw.textbbox((0, 0), LETTER, font=font)
    scale = SIZE * LETTER_HEIGHT_RATIO / (b - t)
    font = ImageFont.truetype(FONT_PATH, int(font_size * scale), index=FONT_INDEX)
    l, t, r, b = draw.textbbox((0, 0), LETTER, font=font)
    x = (SIZE - (r - l)) / 2 - l
    y = (SIZE - (b - t)) / 2 - t
    draw.text((x, y), LETTER, font=font, fill=(255, 255, 255, 255))

    out = os.path.join(HERE, 'icon-source.png')
    bg.save(out, 'PNG')
    print(f'已生成 {out}')


if __name__ == '__main__':
    main()
