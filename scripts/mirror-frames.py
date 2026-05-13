"""
把 learn 目录的帧做对称（ping-pong）复制。

原序列：003.png – 172.png（170 帧）
结果：  003.png – 172.png（正向，保留）
        173.png – 341.png（反向，171→003，轴 172 和首帧 003 各不重复）

用法：
  python scripts/mirror-frames.py 设定/learn
"""
import sys
import shutil
from pathlib import Path


def mirror(src: Path) -> None:
    frames = sorted(src.glob("*.png"), key=lambda p: int(p.stem))
    if not frames:
        raise SystemExit(f"未找到 PNG: {src}")

    first_num = int(frames[0].stem)
    last_num = int(frames[-1].stem)

    # 反向序列：去掉最后一帧（对称轴 172 不重复），首帧 003 保留——
    # 这样 003 同时出现在正向开头（003）和反向末尾，形成完整对称
    rev = list(reversed(frames[:-1]))  # 171, 170, ..., 003（169 帧）

    start_num = last_num + 1  # 173
    for i, fp in enumerate(rev):
        new_name = f"{start_num + i:03d}.png"
        shutil.copy(fp, src / new_name)

    end_num = start_num + len(rev) - 1
    total = last_num - first_num + 1 + len(rev)
    print(
        f"正向 {first_num:03d}–{last_num:03d}（{last_num - first_num + 1} 帧）"
        f"  +  反向 {start_num:03d}–{end_num:03d}（{len(rev)} 帧）"
        f"  =  总 {total} 帧（{first_num:03d}–{end_num:03d}）"
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("用法: python scripts/mirror-frames.py <dir>")
    mirror(Path(sys.argv[1]))
