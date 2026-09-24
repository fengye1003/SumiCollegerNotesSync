#!/usr/bin/env python
"""crop.py -- crop a region and upscale (nearest) for visual comparison.
Usage: python crop.py <src> <out.png> <x0> <y0> <x1> <y1> [--zoom N] [--grid N]
ASCII only.
"""
import sys, json

def main():
    a = sys.argv[1:]
    src, out = a[0], a[1]
    x0, y0, x1, y1 = [int(v) for v in a[2:6]]
    zoom = 5
    if '--zoom' in a:
        zoom = int(a[a.index('--zoom') + 1])
    from PIL import Image
    im = Image.open(src).convert("RGB").crop((x0, y0, x1, y1))
    im = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
    im.save(out)
    print(json.dumps({"out": out, "w": im.width, "h": im.height}))

main()
