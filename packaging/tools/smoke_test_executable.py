"""Start a packaged Specter EW executable and verify its local HTTP UI."""

from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(
            ['taskkill', '/PID', str(process.pid), '/T', '/F'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('--timeout', type=float, default=60.0)
    args = parser.parse_args()

    executable = args.executable.resolve()
    if not executable.exists():
        parser.error(f'executable does not exist: {executable}')

    port = available_port()
    url = f'http://127.0.0.1:{port}/'
    environment = os.environ.copy()
    environment['SPECTER_DISABLE_BROWSER'] = '1'
    process = subprocess.Popen(
        [str(executable), '--local', '--port', str(port)],
        cwd=str(executable.parent),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=(os.name != 'nt'),
    )

    deadline = time.monotonic() + args.timeout
    try:
        while time.monotonic() < deadline:
            return_code = process.poll()
            if return_code is not None:
                output = process.stdout.read() if process.stdout else ''
                raise RuntimeError(
                    f'{executable.name} exited with code {return_code}\n{output}'
                )
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    body = response.read()
                    if response.status == 200 and body:
                        with urllib.request.urlopen(f'{url}license', timeout=2) as license_response:
                            license_body = license_response.read()
                        if b'GNU AFFERO GENERAL PUBLIC LICENSE' not in license_body:
                            raise RuntimeError('packaged application did not serve the AGPL license')
                        print(f'Packaged application responded successfully at {url}')
                        return 0
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.5)
        raise RuntimeError(f'timed out waiting for {url}')
    finally:
        stop_process(process)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f'Smoke test failed: {exc}', file=sys.stderr)
        raise SystemExit(1)
