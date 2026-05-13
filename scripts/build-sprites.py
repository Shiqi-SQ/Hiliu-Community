"""
把 设定/start 和 设定/exit 下的逐帧 PNG 拼成网格布局的精灵图，
输出无损 WebP 到 src/renderer/src/assets/{start,exit,...}.webp。

为什么是网格而不是单行：
  WebP 单图最大 16383 像素，103/110 帧 × 240px 横向拼接会超限。
  改成 GRID_COLS 列固定布局，超出换行——start 103 帧 = 2 行（128 槽，padding 25），
  exit 110 帧 = 2 行（128 槽，padding 18）。

要点同步给运行时：shared/types.ts 的 SPRITE_GRID_COLS 常量必须与本脚本一致；
CLIP_REGISTRY 每项的 frameCount 也要按本脚本输出的帧数对齐（脚本会 print）。

镜像版（right 朝向）命名规则：{name}-r.webp（不用 {name}[r].webp）。
方括号在 Vite/esbuild asset import 路径解析时会被当作 glob 字符类，导致运行时 URL 异常。
"""
from math import ceil
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
FRAME_WIDTH = 240
FRAME_HEIGHT = 280
# 单行最多多少帧——15360 < WebP 16383 上限。任何 ≤68 的值都安全
GRID_COLS = 64

# 四元组 (name, src_dir, out_path, mirror)。
# 镜像版（[r]）通过同源目录在 stitch() 内 ImageOps.mirror 翻转每帧后入 atlas，
# 不再单独存 设定/{clip}[r]/ 文件夹——省磁盘也省一次「忘了同步左右」的对齐风险。
JOBS = [
    ('start', ROOT / '设定' / 'start', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'start.webp', False),
    ('exit', ROOT / '设定' / 'exit', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'exit.webp', False),
    ('idle-tire', ROOT / '设定' / 'idle-tire', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'idle-tire.webp', False),
    ('idle-playball', ROOT / '设定' / 'idle-playball', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'idle-playball.webp', False),
    # idle-tire2 是三段链：start (oneshot) → loop (loop) → end (oneshot)，演完整套「伸懒腰 + 揉眼 + 复位」。
    # 切段时 Pet 状态机用 playClip(...,{next:'idle-tire2-loop'}) 串接，让循环段独立循环若干次后再播 end 自然收尾。
    ('idle-tire2-start', ROOT / '设定' / 'idle-tire2-start', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'idle-tire2-start.webp', False),
    ('idle-tire2-loop', ROOT / '设定' / 'idle-tire2-loop', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'idle-tire2-loop.webp', False),
    ('idle-tire2-end', ROOT / '设定' / 'idle-tire2-end', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'idle-tire2-end.webp', False),
    # walk 三段链：start (oneshot) → loop (loop) → end (oneshot)，仿照 idle-tire2 链。
    # 想让桌宠走起来：playClip('walk-start',{next:'walk-loop'})，要停时 playClip('walk-end')。
    ('walk-start', ROOT / '设定' / 'walk-start', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'walk-start.webp', False),
    ('walk-loop', ROOT / '设定' / 'walk-loop', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'walk-loop.webp', False),
    ('walk-end', ROOT / '设定' / 'walk-end', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'walk-end.webp', False),
    # turn：转身过渡（左↔右），oneshot；接在 walk-loop / idle 之间用来翻转朝向。
    ('turn', ROOT / '设定' / 'turn', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'turn.webp', False),
    # learn：阅读/学习动画，ping-pong 对称（003–341），loop。
    ('learn', ROOT / '设定' / 'learn', ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'learn.webp', False),
]
# 追加镜像 JOB：复用 left 源目录，输出 {name}-r.webp（-r 后缀，避免方括号在 Vite/glob 里的路径解析问题）。
# 成对生成保证 CLIP_SOURCES 嵌套 Record 两侧永远同步——跑一次脚本，22 个 webp 全都到位。
JOBS = JOBS + [
    (f'{name}-r', src, out.parent / f'{out.stem}-r.webp', True)
    for name, src, out, _ in JOBS
]


def stitch(name: str, src_dir: Path, out_path: Path, mirror: bool = False) -> None:
    frames = sorted(src_dir.glob('*.png'), key=lambda p: int(p.stem))
    if not frames:
        raise SystemExit(f'no frames found in {src_dir}')

    rows = ceil(len(frames) / GRID_COLS)
    sheet = Image.new(
        'RGBA',
        (GRID_COLS * FRAME_WIDTH, rows * FRAME_HEIGHT),
        (0, 0, 0, 0),
    )
    for i, fp in enumerate(frames):
        with Image.open(fp) as f:
            if f.size != (FRAME_WIDTH, FRAME_HEIGHT):
                raise SystemExit(f'{fp} size {f.size} != ({FRAME_WIDTH},{FRAME_HEIGHT})')
            frame_img = f.convert('RGBA')
            if mirror:
                frame_img = ImageOps.mirror(frame_img)
            col = i % GRID_COLS
            row = i // GRID_COLS
            sheet.paste(frame_img, (col * FRAME_WIDTH, row * FRAME_HEIGHT))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # WebP 无损：lossless=True + method=6（最慢档压缩最好），quality 在无损模式下作为压缩努力度
    sheet.save(out_path, format='WEBP', lossless=True, quality=100, method=6)
    size_mb = out_path.stat().st_size / 1024 / 1024
    suffix = ' [mirrored]' if mirror else ''
    print(
        f'[{name}]{suffix} {len(frames)} frames, {GRID_COLS}×{rows} grid '
        f'-> {out_path.name}: {size_mb:.2f} MB'
    )


if __name__ == '__main__':
    for name, src, out, mirror in JOBS:
        stitch(name, src, out, mirror)
