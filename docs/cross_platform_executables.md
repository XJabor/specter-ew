# Linux and macOS executable builds

Specter EW is packaged with PyInstaller as a local Flask server. The terminal
executables print the URL to open, while desktop launchers start in local-only
mode and open `http://localhost:5000` automatically.

PyInstaller does not cross-compile. Build Linux artifacts on Linux and each
macOS architecture on matching Apple hardware. The GitHub Actions workflow in
`.github/workflows/build-release.yml` handles those native builds automatically.

## Release artifacts

| Artifact | Target | Contents |
|---|---|---|
| `SpecterEW-linux-x86_64.tar.gz` | Ubuntu 22.04-compatible x86_64 Linux | Terminal executable |
| `SpecterEW-linux-desktop-x86_64.tar.gz` | x86_64 Linux desktop | Executable, `.desktop` launcher, icon, instructions |
| `SpecterEW-macos-x86_64.tar.gz` | Intel Mac | Terminal executable |
| `SpecterEW-macos-x86_64-app.zip` | Intel Mac | Finder-launchable `.app` |
| `SpecterEW-macos-arm64.tar.gz` | Apple Silicon Mac | Terminal executable |
| `SpecterEW-macos-arm64-app.zip` | Apple Silicon Mac | Finder-launchable `.app` |

The Linux binary is linked against the Ubuntu 22.04 glibc baseline. Linux
ARM64, AppImage, DEB/RPM, DMG, and universal macOS binaries are not currently
produced.

## Automated builds and releases

Pull requests, pushes to `main`, and manual workflow runs build and smoke-test
all targets. Tags beginning with `v` (for example, `v1.2.0`) additionally create
a GitHub Release containing every Linux, macOS, and Windows artifact.

The smoke test starts each packaged executable on a temporary localhost port
and confirms that the web interface responds. The build fails if bundled
templates, static files, or native dependencies cannot load.

## Local Linux build

Install Python 3.12 and its venv support, then run:

```bash
bash build_linux.sh
```

Artifacts are written to `release/`. To reuse an existing `.venv-build`:

```bash
SKIP_INSTALL=1 bash build_linux.sh
```

For the desktop archive, extract all files into the same directory and run
`bash install-desktop.sh`. This installs a per-user application-menu launcher
pointing to that directory. Its terminal remains visible so closing it stops
the server. Rerun the installer after moving the extracted directory.

## Local macOS build

Install Python 3.12 on the target Mac, then run:

```bash
bash build_macos.sh
```

The script names artifacts from `uname -m`, producing either `x86_64` or
`arm64`. It builds a terminal executable and a Finder-launchable `.app`.

### Gatekeeper

The macOS artifacts do not carry a Developer ID signature and are not
notarized. Gatekeeper may block the first launch. Users who trust the artifact
can Control-click the app, choose **Open**, and confirm. Developer ID signing
and Apple notarization should be added before broad public distribution.

## Runtime options

Terminal builds support:

```bash
./SpecterEW --local
./SpecterEW --lan
./SpecterEW --host 127.0.0.1 --port 5000
./SpecterEW --local --open-browser
```

`--open-browser` opens the local URL shortly after startup. Desktop launchers
always bind to `127.0.0.1` regardless of command-line host arguments. LAN mode
may trigger a host firewall prompt and should only be used on trusted networks.

Environment variables `SPECTER_BIND_HOST` and `SPECTER_PORT` remain available
for terminal builds. Set `SPECTER_DISABLE_BROWSER=1` to suppress automatic
browser launch in automation.

## Runtime data

Bundled templates and static files are read from PyInstaller's extraction
directory. Writable runtime files stay beside the executable:

```text
SpecterEW
specter_config.json
local_data/
  w094/
    n29.dt2
```

The localhost data-directory UI may point to a different directory. The usual
online map, Clerk, and OpenTopoData functionality still requires internet
access.
