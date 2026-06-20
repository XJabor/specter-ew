"""Desktop-only entry point for the macOS app bundle.

The desktop build is intentionally loopback-only. LAN access remains available
from the terminal executable through ``--lan`` or ``--host``.
"""

from app import main


if __name__ == '__main__':
    main(force_host='127.0.0.1', default_open_browser=True)
