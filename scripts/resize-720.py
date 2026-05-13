"""
把 720×720 逐帧 PNG 缩放并加边框到 240×280，输出到目标目录。

缩放配方（与其他 clip 对齐）：
  720×720 → 缩到 190×190（Lanczos）→ 加边框 左26/上47/右24/下43 → 240×280

用法：
  python scripts/resize-720.py 设定/learn-720 设定/learn
"""
import sys
from pathlib import Path
from PIL import Image

INNER_SIZE = 190          # 缩放后的内容尺寸
PAD_LEFT, PAD_TOP = 26, 47
PAD_RIGHT, PAD_BOTTOM = 24, 43
FRAME_W = INNER_SIZE + PAD_LEFT + PAD_RIGHT  # 240
FRAME_H = INNER_SIZE + PAD_TOP + PAD_BOTTOM  # 280

assert FRAME_W == 240 and FRAME_H == 280


def resize_dir(src: Path, dst: Path) -> None:
    frames = sorted(src.glob('*.png'), key=lambda p: int(p.stem))
    if not frames:
        raise SystemExit(f'未找到 PNG: {src}')

    dst.mkdir(parents=True, exist_ok=True)
    for fp in frames:
        with Image.open(fp) as img:
            img = img.convert('RGBA')
            # 等比缩到 190×190（源图通常是正方形；若非正方形则强制缩放到方形）
            img = img.resize((INNER_SIZE, INNER_SIZE), Image.LANCZOS)
            canvas = Image.new('RGBA', (FRAME_W, FRAME_H), (0, 0, 0, 0))
            canvas.paste(img, (PAD_LEFT, PAD_TOP))
            canvas.save(dst / fp.name, format='PNG')

    print(f'{len(frames)} 帧  {src.name} -> {dst.name}  ({FRAME_W}×{FRAME_H})')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('用法: python scripts/resize-720.py <src_dir> <dst_dir>')
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    if not src.is_dir():
        raise SystemExit(f'源目录不存在: {src}')
    resize_dir(src, dst)
