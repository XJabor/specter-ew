"""Backend → frontend contract for calculation diagnostics.

tests/fixtures/api_responses.json holds real responses from the calculation
endpoints (flat mocked terrain). The Node tests in tests/js/ feed them to the
frontend result model and report, so this test keeps the fixture's field
structure identical to what the backend returns today: if a diagnostic field
is added, renamed, or removed, regenerate the fixture and update the frontend.

    python -m tests.test_api_fixtures --regenerate
"""

import json
import os
import sys
import unittest
from unittest.mock import patch

import app
import core.elevation as elevation

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'api_responses.json')

EA_BASE = {
    'freq_mhz': 60, 'enemy_terrain': 'rural', 'jammer_terrain': 'rural',
    'enemy_tx_w': 5, 'enemy_tx_gain': 0, 'enemy_rx_gain': 0, 'enemy_dist_km': 5.0,
    'jammer_tx_w': 50, 'jammer_tx_gain': 3, 'jammer_dist_km': 3.0,
    'apply_fh': True, 'enemy_bw_khz': 25, 'jammer_bw_khz': 250,
    'lower_threshold': -6, 'upper_threshold': 6,
}
EA_COORDS = {
    'tx_lat': 35.0, 'tx_lon': -117.0, 'rx_lat': 35.045, 'rx_lon': -117.0,
    'jammer_lat': 35.045, 'jammer_lon': -116.967,
    'tx_antenna_type': 'omni', 'rx_antenna_type': 'omni',
    'jammer_antenna_type': 'directional', 'jammer_azimuth_deg': 250, 'jammer_beamwidth_deg': 60,
    'tx_antenna_height_m': 2, 'rx_antenna_height_m': 2, 'jammer_antenna_height_m': 5,
}
RING = {
    'freq_mhz': 150, 'enemy_terrain': 'rural', 'enemy_tx_w': 5, 'enemy_tx_gain': 0,
    'rx_sensitivity': -100, 'friendly_rx_gain': 0, 'enemy_lat': 35.0, 'enemy_lon': -117.0,
    'tx_antenna_type': 'omni', 'tx_antenna_height_m': 2,
}
SHF_RING = {**RING, 'freq_mhz': 5800, 'enemy_terrain': 'light forest', 'enemy_tx_w': 1}
FOOTPRINT = {
    'freq_mhz': 150, 'jammer_terrain': 'rural', 'jammer_tx_w': 20, 'jammer_tx_gain': 3,
    'rx_sensitivity': -90, 'friendly_rx_gain': 0, 'jammer_lat': 35.0, 'jammer_lon': -117.0,
    'jammer_antenna_type': 'omni', 'jammer_antenna_height_m': 2,
}


def _flat_mixed(locations):
    # Every 4th sample "from the online API" so the elevation summary is 'mixed'.
    return elevation._Elevations([0.0] * len(locations), [i % 4 == 0 for i in range(len(locations))])


def _offline(locations):
    raise RuntimeError('elevation service offline')


def generate():
    client = app.app.test_client()

    def post(endpoint, payload, fetcher):
        elevation._profile_cache.clear()
        elevation._profile_source.clear()
        with patch.object(elevation, '_fetch_elevations', fetcher):
            resp = client.post(endpoint, json=payload, environ_base={'REMOTE_ADDR': '127.0.0.1'})
        data = resp.get_json()
        assert data['status'] == 'success', data
        return {'request': payload, 'response': data}

    return {
        'ea_terrain': post('/calculate_ea', {**EA_BASE, **EA_COORDS}, _flat_mixed),
        'ea_no_coords': post('/calculate_ea', EA_BASE, _flat_mixed),
        'es_ring': post('/calculate_es_terrain', RING, _flat_mixed),
        'shf_ring': post('/calculate_es_terrain', SHF_RING, _flat_mixed),
        'footprint_fallback': post('/calculate_jammer_footprint', FOOTPRINT, _offline),
    }


def _shape(value):
    """Structural signature: dict keys recursively, list element shape, leaf type."""
    if isinstance(value, dict):
        return {k: _shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return ['list', _shape(value[0]) if value else None]
    if isinstance(value, bool) or value is None:
        return type(value).__name__
    if isinstance(value, (int, float)):
        return 'number'
    return type(value).__name__


class ApiFixtureShapeTests(unittest.TestCase):
    maxDiff = None

    def test_fixture_matches_current_backend_shape(self):
        with open(FIXTURE, encoding='utf-8') as fh:
            committed = json.load(fh)
        current = generate()
        self.assertEqual(set(committed), set(current))
        for name in current:
            with self.subTest(name):
                self.assertEqual(_shape(committed[name]['response']),
                                 _shape(current[name]['response']),
                                 f'{name}: response shape changed; regenerate the fixture '
                                 'and update static/js/calc_results.js if needed')


if __name__ == '__main__':
    if '--regenerate' in sys.argv:
        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(generate(), fh, indent=1, sort_keys=True)
            fh.write('\n')
        print(f'wrote {FIXTURE}')
    else:
        unittest.main()
