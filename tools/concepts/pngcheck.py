#!/usr/bin/env python
# pngcheck.py -- 机械体检：批量算 PNG 的「墨迹占比」（非背景像素比例）
# 用途：批量渲染后确认没有空白页/黑页，不看图也能判断渲染是否正常
# 用法: python pngcheck.py <png 目录> [背景色容差=12]
import sys, os, glob
from PIL import Image

def ink_ratio(path, tol=12):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    # 背景 = 四角像素的中位色
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    step = 2  # 隔点采样，速度与精度折中
    n = dark = 0
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            n += 1
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > tol * 3:
                dark += 1
    return w, h, bg, (dark / n if n else 0.0)

def main():
    raw = sys.argv[1:]
    pos, i, out = [], 0, None
    while i < len(raw):
        if raw[i] == '--out':
            out = raw[i + 1] if i + 1 < len(raw) else None
            i += 2
            continue
        if raw[i].startswith('--'):
            i += 1
            continue
        pos.append(raw[i]); i += 1
    d = pos[0] if len(pos) > 0 else '.'
    tol = int(pos[1]) if len(pos) > 1 else 12
    files = sorted(glob.glob(os.path.join(d, '*.png')))
    lines = ['%-44s %10s %7s  %s' % ('file', 'size', 'ink%', 'bg')]
    bad = 0
    for f in files:
        try:
            w, h, bg, r = ink_ratio(f, tol)
            flag = ''
            if r < 0.001:
                flag = '  <== SUSPECT: blank page'; bad += 1
            elif r > 0.9:
                flag = '  <== SUSPECT: all ink / bg detect failed'; bad += 1
            lines.append('%-44s %5dx%-5d %6.2f%%  %s%s' % (os.path.basename(f), w, h, r * 100, bg, flag))
        except Exception as e:
            lines.append('%-44s ERROR %s' % (os.path.basename(f), e)); bad += 1
    lines.append('')
    lines.append('%d files, %d suspicious' % (len(files), bad))
    text = '\n'.join(lines) + '\n'
    if out:
        # 自己写文件（UTF-8），避免 PS 5.1 的 `>` 重定向写成 UTF-16
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write(text)
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode('ascii', 'replace').decode('ascii'))
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main())
