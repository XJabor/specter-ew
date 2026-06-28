import os
import sys
import unittest
import json
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

    def test_license_endpoint_serves_agpl(self):
        response = app.app.test_client().get(
            '/license', environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'GNU AFFERO GENERAL PUBLIC LICENSE', response.data)

    def test_application_pages_include_agpl_notices(self):
        client = app.app.test_client()
        for endpoint in ('/', '/login'):
            with self.subTest(endpoint=endpoint):
                response = client.get(
                    endpoint, environ_base={'REMOTE_ADDR': '127.0.0.1'}
                )
                self.assertEqual(response.status_code, 200)
                self.assertIn(b'&copy; 2026 John E. Plaziak.', response.data)
                self.assertIn(
                    b'Licensed under the GNU Affero General Public License v3.0.',
                    response.data,
                )
                self.assertIn(b'href="/license"', response.data)
                self.assertIn(
                    b'href="https://github.com/XJabor/specter-ew"', response.data
                )
                self.assertIn(b'No warranty.', response.data)

    def test_index_includes_scenario_controls(self):
        response = app.app.test_client().get(
            '/', environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )
        self.assertEqual(response.status_code, 200)
        for expected in (
            b'id="scenario-name"',
            b'id="btn-save-scenario"',
            b'id="btn-save-copy"',
            b'id="btn-load-scenario"',
            b'id="btn-new-scenario"',
            b'id="scenario-file-input"',
            b'id="scenario-dirty-indicator"',
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, response.data)

    def test_index_includes_library_builder_controls(self):
        response = app.app.test_client().get(
            '/', environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )
        self.assertEqual(response.status_code, 200)
        for expected in (
            b'data-workbench-tab="library"',
            b'data-workbench-tab="builder"',
            b'id="library-template-select"',
            b'id="library-role-select"',
            b'id="btn-place-library-node"',
            b'id="btn-library-import"',
            b'id="btn-library-export"',
            b'id="builder-name"',
            b'id="btn-builder-save"',
            b'id="selected-node-status"',
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, response.data)

    def test_index_includes_about_support_panel(self):
        response = app.app.test_client().get(
            '/', environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )
        self.assertEqual(response.status_code, 200)
        for expected in (
            b'data-workbench-tab="about"',
            b'id="about-support-panel"',
            b'id="about-app-version"',
            b'id="about-deployment-mode"',
            b'id="commercial-license-cta"',
            b'GNU AGPL-3.0',
            b'GNU Affero General Public License v3.0',
            b'href="/license"',
            b'href="https://github.com/XJabor/specter-ew"',
            b'proprietary deployment rights',
            b'validation artifacts',
            b'enterprise packaging',
            b'licensing@specter-ew.com',
            b'contact@specter-ew.com',
            b'.specter.json',
            b'Clerk login does not provide cloud scenario storage',
            b'id="btn-about-support"',
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, response.data)

    def test_deployment_mode_label_is_rendered(self):
        cases = (
            ('', {}, b'Local/open'),
            ('', {'APP_CREDENTIALS': 'user:pass'}, b'Session login'),
            ('pk_test_dummy', {}, b'Clerk'),
        )
        client = app.app.test_client()
        for clerk_key, environment, expected in cases:
            with self.subTest(expected=expected), patch.object(app, '_CLERK_PK', clerk_key), patch.dict(
                os.environ, environment, clear=True
            ):
                response = client.get('/', environ_base={'REMOTE_ADDR': '127.0.0.1'})
                self.assertEqual(response.status_code, 200)
                self.assertIn(expected, response.data)

    def test_builtin_equipment_profiles_are_valid(self):
        profile_path = Path(__file__).resolve().parents[1] / 'static' / 'equipment_profiles.json'
        data = json.loads(profile_path.read_text(encoding='utf-8'))
        self.assertEqual(data['schema_version'], 2)
        self.assertEqual(data['pack_id'], 'specter-builtins')
        self.assertIsInstance(data['templates'], list)
        self.assertGreaterEqual(len(data['templates']), 3)

        equipment_types = {'radio', 'receiver', 'jammer'}
        numeric_ranges = {
            'frequency_mhz': (1, 40000),
            'tx_power_w': (0.001, 1000000),
            'antenna_gain_dbi': (-60, 80),
            'rx_sensitivity_dbm': (-200, 0),
            'antenna_height_m': (1, 500),
            'beamwidth_deg': (1, 360),
        }
        seen = set()
        for template in data['templates']:
            with self.subTest(template=template.get('id')):
                self.assertNotIn(template['id'], seen)
                seen.add(template['id'])
                self.assertIn(template['equipment_type'], equipment_types)
                self.assertNotEqual(template['equipment_type'], 'jammer')
                self.assertNotIn('generic', template['id'].lower())
                self.assertNotIn('generic', template['name'].lower())
                self.assertTrue(template['name'])
                self.assertIn('source_url', template)
                for field, bounds in numeric_ranges.items():
                    if field in template:
                        self.assertIsInstance(template[field], (int, float))
                        self.assertGreaterEqual(template[field], bounds[0])
                        self.assertLessEqual(template[field], bounds[1])

    def test_equipment_profile_static_endpoint(self):
        response = app.app.test_client().get(
            '/static/equipment_profiles.json',
            environ_base={'REMOTE_ADDR': '127.0.0.1'},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['pack_id'], 'specter-builtins')

    def test_frontend_scenario_profile_hooks_are_present(self):
        script = (
            Path(__file__).resolve().parents[1] / 'static' / 'js' / 'map_logic.js'
        ).read_text(encoding='utf-8')
        self.assertIn('const SCENARIO_SCHEMA_VERSION = 3;', script)
        self.assertIn('profile_library: scenarioProfileLibraryState()', script)
        self.assertIn('mergeUserProfilePacks(scenario.profile_library.packs)', script)
        self.assertIn('[1, 2].includes(Number(data.schema_version))', script)
        self.assertIn('equipment: equipmentScenarioState(node,', script)


if __name__ == '__main__':
    unittest.main()
