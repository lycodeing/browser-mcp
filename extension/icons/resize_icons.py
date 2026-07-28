#!/usr/bin/env python3
"""
将 icon-source.png 缩放为 Chrome 扩展所需的三个尺寸
运行：python3 resize_icons.py
"""
from PIL import Image
import os

SRC = os.path.join(os.path.dirname(__file__), 'icon-source.png')
SIZES = [16, 48, 128]

img = Image.open(SRC).convert('RGBA')

for size in SIZES:
    out_path = os.path.join(os.path.dirname(__file__), f'icon{size}.png')
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(out_path, 'PNG')
    print(f'已生成 {out_path}')

print('完成！')
