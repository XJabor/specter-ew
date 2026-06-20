"""Generate PNG and macOS ICNS variants from the shared Specter EW artwork."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image

from make_windows_icon import _render


ROOT = Path(__file__).resolve().parents[1]
PNG_OUT = ROOT / 'assets' / 'specterew.png'
ICNS_OUT = ROOT / 'assets' / 'specterew.icns'


def main() -> None:
    PNG_OUT.parent.mkdir(parents=True, exist_ok=True)
    png_bytes = _render(512)
    PNG_OUT.write_bytes(png_bytes)

    with Image.open(BytesIO(png_bytes)) as image:
        image.save(ICNS_OUT, format='ICNS', append_images=[])

    print(f'Wrote {PNG_OUT}')
    print(f'Wrote {ICNS_OUT}')


if __name__ == '__main__':
    main()
