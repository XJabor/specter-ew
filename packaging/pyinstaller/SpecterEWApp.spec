# -*- mode: python ; coding: utf-8 -*-

from importlib.util import find_spec
from pathlib import Path
from PyInstaller.utils.hooks import collect_all


ROOT = Path(SPECPATH).resolve().parents[1]
datas = [
    (str(ROOT / 'templates'), 'templates'),
    (str(ROOT / 'static'), 'static'),
    (str(ROOT / 'LICENSE'), '.'),
]
binaries = []
hiddenimports = []


def collect_optional(package_name):
    if find_spec(package_name) is None:
        return
    package_datas, package_binaries, package_hiddenimports = collect_all(package_name)
    datas.extend(package_datas)
    binaries.extend(package_binaries)
    hiddenimports.extend(package_hiddenimports)


for package in ('rasterio', 'pyproj', 'shapely', 'PIL', 'certifi'):
    collect_optional(package)


a = Analysis(
    [str(ROOT / 'packaging' / 'entrypoints' / 'desktop_entry.py')],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='SpecterEW',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / 'assets' / 'specterew.icns'),
)
app = BUNDLE(
    exe,
    name='SpecterEW.app',
    icon=str(ROOT / 'assets' / 'specterew.icns'),
    bundle_identifier='com.specter-ew.app',
    info_plist={
        'CFBundleDisplayName': 'Specter EW',
        'CFBundleName': 'Specter EW',
        'NSHighResolutionCapable': True,
    },
)
