"""Generate the Windows .ico used for the PyInstaller build.

The icon is intentionally generated with the standard library so release builds
do not need Pillow just to refresh the executable icon.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "specterew.ico"


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def _png_rgba(width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    rows = []
    for y in range(height):
        start = y * width
        row = bytearray([0])
        for r, g, b, a in pixels[start : start + width]:
            row.extend((r, g, b, a))
        rows.append(bytes(row))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + _png_chunk(b"IEND", b"")
    )


def _inside_ghost(x: float, y: float, size: int) -> bool:
    s = size / 256.0
    cx = 128.0 * s
    cy = 92.0 * s
    radius = 70.0 * s
    left = cx - radius
    right = cx + radius
    bottom = (188.0 + 12.0 * math.sin((x - left) / (right - left) * math.tau * 3.0)) * s

    if y < cy:
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2
    return left <= x <= right and cy <= y <= bottom


def _ellipse_mask(x: float, y: float, cx: float, cy: float, rx: float, ry: float) -> bool:
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0


def _sample(x: float, y: float, size: int) -> tuple[int, int, int, int]:
    s = size / 256.0
    if not _inside_ghost(x, y, size):
        return (0, 0, 0, 0)

    outline = False
    probe = max(1.0, 3.0 * s)
    for dx, dy in ((probe, 0), (-probe, 0), (0, probe), (0, -probe)):
        if not _inside_ghost(x + dx, y + dy, size):
            outline = True
            break

    if outline:
        return (12, 28, 45, 255)

    # Soft spectral fill, bright enough to read at 16 px.
    top = max(0.0, min(1.0, y / size))
    r = int(225 - 35 * top)
    g = int(250 - 42 * top)
    b = int(255 - 8 * top)

    # Cyan lower shadow.
    if y > 150 * s:
        g = min(255, g + 8)
        b = min(255, b + 18)

    eyes = (
        (99 * s, 105 * s, 18 * s, 24 * s),
        (157 * s, 105 * s, 18 * s, 24 * s),
    )
    pupils = (
        (105 * s, 111 * s, 7 * s, 10 * s),
        (163 * s, 111 * s, 7 * s, 10 * s),
    )

    for eye in eyes:
        if _ellipse_mask(x, y, *eye):
            return (246, 252, 255, 255)

    for pupil in pupils:
        if _ellipse_mask(x, y, *pupil):
            return (18, 34, 63, 255)

    return (r, g, b, 255)


def _render(size: int) -> bytes:
    scale = 4
    hi = size * scale
    pixels = []
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(scale):
                for sx in range(scale):
                    px = (x * scale + sx + 0.5) / hi * size
                    py = (y * scale + sy + 0.5) / hi * size
                    color = _sample(px, py, size)
                    for i, value in enumerate(color):
                        acc[i] += value
            pixels.append(tuple(v // (scale * scale) for v in acc))
    return _png_rgba(size, size, pixels)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    images = [(size, _render(size)) for size in (16, 24, 32, 48, 64, 128, 256)]

    header = struct.pack("<HHH", 0, 1, len(images))
    directory = bytearray()
    payload = bytearray()
    offset = 6 + 16 * len(images)

    for size, data in images:
        width_byte = 0 if size == 256 else size
        height_byte = 0 if size == 256 else size
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                width_byte,
                height_byte,
                0,
                0,
                1,
                32,
                len(data),
                offset,
            )
        )
        payload.extend(data)
        offset += len(data)

    OUT.write_bytes(header + directory + payload)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
