import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class RuntimeOptionsTests(unittest.TestCase):
    def resolve(self, *arguments, force_host=None, environment=None):
        environment = environment or {}
        with patch.object(sys, 'argv', ['SpecterEW', *arguments]), patch.dict(
            os.environ, environment, clear=True
        ), patch.object(app, '_is_frozen', return_value=False):
            return app._resolve_bind_options(force_host=force_host)

    def test_local_and_lan_flags(self):
        self.assertEqual(self.resolve('--local'), ('127.0.0.1', 5000))
        self.assertEqual(self.resolve('--lan'), ('0.0.0.0', 5000))

    def test_explicit_host_port_and_environment(self):
        self.assertEqual(
            self.resolve('--host', '127.0.0.1', '--port', '5100'),
            ('127.0.0.1', 5100),
        )
        self.assertEqual(
            self.resolve(environment={'SPECTER_BIND_HOST': 'lan', 'SPECTER_PORT': '5200'}),
            ('0.0.0.0', 5200),
        )

    def test_desktop_force_host_cannot_be_overridden(self):
        self.assertEqual(
            self.resolve('--lan', '--port', '5300', force_host='127.0.0.1'),
            ('127.0.0.1', 5300),
        )

    def test_invalid_port_is_rejected(self):
        for value in ('not-a-port', '0', '65536'):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                self.resolve('--port', value)

    def test_open_browser_flag_schedules_local_url(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            app.threading, 'Timer'
        ) as timer:
            app._open_browser_later(5400, delay_seconds=0.25)

        timer.assert_called_once_with(
            0.25,
            app.webbrowser.open,
            args=('http://localhost:5400',),
        )
        timer.return_value.start.assert_called_once_with()
        self.assertTrue(timer.return_value.daemon)

    def test_runtime_root_is_executable_directory_when_frozen(self):
        fake_executable = Path('C:/opt/SpecterEW/SpecterEW')
        with patch.object(app, '_is_frozen', return_value=True), patch.object(
            sys, 'executable', str(fake_executable)
        ):
            self.assertEqual(app._runtime_root(), fake_executable.resolve().parent)

    def test_macos_app_runtime_root_is_beside_bundle(self):
        fake_executable = Path('/Applications/SpecterEW.app/Contents/MacOS/SpecterEW')
        with patch.object(app, '_is_frozen', return_value=True), patch.object(
            sys, 'executable', str(fake_executable)
        ), patch.object(sys, 'platform', 'darwin'):
            self.assertEqual(app._runtime_root(), fake_executable.resolve().parents[3])


if __name__ == '__main__':
    unittest.main()
