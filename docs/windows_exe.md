# Windows executable build

Specter EW can be packaged as a Windows executable with PyInstaller. The app
still runs as a local Flask server and users open it at:

```text
http://localhost:5000
```

## Build

Use Windows with Python 3.12 installed through the Python launcher.

```powershell
.\packaging\scripts\build_windows.ps1
```

The script:

1. Creates `.venv-build` with Python 3.12.
2. Installs `requirements.txt` and `requirements-build.txt`.
3. Runs `python -m unittest`.
4. Builds a validation onedir bundle at `dist\SpecterEW\SpecterEW.exe`.
5. Builds the final one-file exe at `dist\SpecterEW.exe`.

Both builds embed the project icon from `assets\specterew.ico`. To regenerate
it, run `python packaging\tools\make_windows_icon.py`.

If dependencies are already installed in `.venv-build`, rerun with:

```powershell
.\packaging\scripts\build_windows.ps1 -SkipInstall
```

## Runtime data

The executable reads bundled `templates` and `static` files from PyInstaller's
temporary extraction directory, but writes runtime files beside the exe.

Place optional geospatial data next to the exe:

```text
dist\
  SpecterEW.exe
  local_data\
    w094\
      n29.dt2
```

The localhost data-directory UI can also point to another folder. That selection
is saved to `specter_config.json` beside `SpecterEW.exe`.

## Startup network mode

When launched from the packaged executable, Specter EW asks which network mode to
use:

```text
1) Local only - this computer only (recommended)
2) LAN-wide   - allow other devices on this network
```

Local-only mode binds to `127.0.0.1` and is the safer default. LAN-wide mode
binds to `0.0.0.0`, so other devices can connect at `http://<host-ip>:5000` if
Windows Firewall allows it.

For scripted launches, use:

```powershell
.\SpecterEW.exe --local
.\SpecterEW.exe --lan
.\SpecterEW.exe --host 127.0.0.1 --port 5000
.\SpecterEW.exe --local --open-browser
```

Environment variables are also supported:

```powershell
$env:SPECTER_BIND_HOST = "local" # or "lan"
$env:SPECTER_PORT = "5000"
.\SpecterEW.exe
```

## Notes

- The executable keeps the current hybrid-online behavior. Leaflet, MGRS, online
  map tiles, Clerk, and OpenTopoData fallback still require internet access.
- `rasterio` brings native GDAL/PROJ dependencies. If the one-file exe fails
  around local DTED or GeoTIFF loading, first test the onedir build because it is
  easier to inspect.
- Unsigned executables may trigger Windows Defender or SmartScreen warnings.
  Code signing is recommended before broad distribution.
- Linux and macOS build and release instructions are in
  `docs/cross_platform_executables.md`.
