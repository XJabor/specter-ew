"""Regression tests for the four calculation endpoints.

Elevation fetches are mocked at core.elevation._fetch_elevations — the seam
shared by get_elevation_profile and get_elevation_profiles_batch — so no
network access occurs and results are deterministic (flat terrain at 0 m).
With no local DTED indexed, is_locally_covered() returns False, so terrain
rings always take the API-resolution path (36 bearings x 11 samples).
"""

import unittest
from unittest.mock import patch

import requests

import app
import core.elevation as elevation


def _flat_elevations(locations):
    return [0.0] * len(locations)


def _raise_network_error(locations):
    raise requests.RequestException("elevation API unreachable")


class CalcEndpointTestCase(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        elevation._profile_cache.clear()

    def post(self, endpoint, payload):
        response = self.client.post(
            endpoint, json=payload, environ_base={'REMOTE_ADDR': '127.0.0.1'}
        )
        self.assertEqual(response.status_code, 200)
        return response.get_json()


class CalculateEATests(CalcEndpointTestCase):
    BASE_PAYLOAD = {
        'freq_mhz': 150,
        'enemy_terrain': 'free space',
        'jammer_terrain': 'free space',
        'enemy_tx_w': 5,
        'enemy_tx_gain': 0,
        'enemy_rx_gain': 0,
        'enemy_dist_km': 1.0,
        'jammer_tx_w': 20,
        'jammer_tx_gain': 3,
        'jammer_dist_km': 1.0,
        'apply_fh': False,
        'enemy_bw_khz': 25,
        'jammer_bw_khz': 25,
    }

    def test_happy_path_without_coordinates(self):
        data = self.post('/calculate_ea', dict(self.BASE_PAYLOAD))
        self.assertEqual(data['status'], 'success')
        self.assertIn('margin', data)
        self.assertIn('effect', data)
        self.assertIsNone(data['jammer_los'])
        self.assertIsNone(data['enemy_los'])
        self.assertEqual(data['terrain_warnings'], [])
        # Same distance, more jammer power + gain: jammer must win on margin.
        self.assertGreater(data['margin'], 0)

    def test_happy_path_with_coordinates_and_flat_terrain(self):
        payload = dict(
            self.BASE_PAYLOAD,
            jammer_lat=35.0, jammer_lon=45.0,
            rx_lat=35.01, rx_lon=45.01,
            tx_lat=35.02, tx_lon=45.02,
            tx_antenna_height_m=2, rx_antenna_height_m=2,
            jammer_antenna_height_m=2,
        )
        with patch.object(elevation, '_fetch_elevations', _flat_elevations):
            data = self.post('/calculate_ea', payload)
        self.assertEqual(data['status'], 'success')
        self.assertTrue(data['jammer_los']['is_los'])
        self.assertTrue(data['enemy_los']['is_los'])
        self.assertEqual(data['terrain_warnings'], [])

    def test_elevation_failure_falls_back_with_warnings(self):
        payload = dict(
            self.BASE_PAYLOAD,
            jammer_lat=35.0, jammer_lon=45.0,
            rx_lat=35.01, rx_lon=45.01,
            tx_lat=35.02, tx_lon=45.02,
        )
        with patch.object(elevation, '_fetch_elevations', _raise_network_error):
            data = self.post('/calculate_ea', payload)
        self.assertEqual(data['status'], 'success')
        self.assertIsNone(data['jammer_los'])
        self.assertIsNone(data['enemy_los'])
        self.assertEqual(len(data['terrain_warnings']), 2)

    def test_validation_rejections(self):
        cases = (
            ({'freq_mhz': -150}, 'Frequency'),
            ({'enemy_tx_w': 0}, 'power'),
            ({'jammer_dist_km': 0}, 'Distance'),
            ({'enemy_bw_khz': 0}, 'Bandwidth'),
            ({'jammer_lat': 95}, 'Invalid latitude: jammer_lat'),
            ({'rx_lon': 200, 'rx_lat': 10}, 'Invalid longitude: rx_lon'),
            ({'lower_threshold': 6, 'upper_threshold': -6}, 'threshold'),
        )
        for overrides, expected_fragment in cases:
            with self.subTest(overrides=overrides):
                data = self.post('/calculate_ea', dict(self.BASE_PAYLOAD, **overrides))
                self.assertEqual(data['status'], 'error')
                self.assertIn(expected_fragment, data['message'])


class CalculateESTests(CalcEndpointTestCase):
    def test_happy_path(self):
        data = self.post('/calculate_es', {
            'freq_mhz': 150,
            'enemy_terrain': 'free space',
            'enemy_tx_w': 5,
            'enemy_tx_gain': 0,
            'rx_sensitivity': -90,
            'friendly_rx_gain': 0,
        })
        self.assertEqual(data['status'], 'success')
        self.assertGreater(data['radius_km'], 0)

    def test_validation_rejections(self):
        for overrides, fragment in (
            ({'freq_mhz': 0}, 'Frequency'),
            ({'enemy_tx_w': -1}, 'power'),
        ):
            with self.subTest(overrides=overrides):
                data = self.post('/calculate_es', dict({
                    'freq_mhz': 150, 'enemy_tx_w': 5,
                }, **overrides))
                self.assertEqual(data['status'], 'error')
                self.assertIn(fragment, data['message'])

    def test_omitted_rx_sensitivity_uses_api_default(self):
        """Direct API callers may omit rx_sensitivity; the -90 dBm default is
        part of the public contract (the frontend always sends it explicitly)."""
        payload = {
            'freq_mhz': 150,
            'enemy_terrain': 'free space',
            'enemy_tx_w': 5,
            'enemy_tx_gain': 0,
            'friendly_rx_gain': 0,
        }
        defaulted = self.post('/calculate_es', payload)
        explicit = self.post('/calculate_es', dict(payload, rx_sensitivity=-90))
        self.assertEqual(defaulted['status'], 'success')
        self.assertEqual(defaulted['radius_km'], explicit['radius_km'])


class TerrainRingTestMixin:
    """Shared assertions for the two terrain-aware footprint endpoints."""

    ENDPOINT = None       # '/calculate_es_terrain' or '/calculate_jammer_footprint'
    PREFIX = None         # 'enemy' or 'jammer'
    TERRAIN_KEY = None    # 'enemy_terrain' or 'jammer_terrain'
    HEIGHT_KEY = None     # 'tx_antenna_height_m' or 'jammer_antenna_height_m'

    def make_payload(self, **overrides):
        p = self.PREFIX
        payload = {
            'freq_mhz': 150,
            self.TERRAIN_KEY: 'free space',
            f'{p}_tx_w': 5,
            f'{p}_tx_gain': 0,
            'rx_sensitivity': -90,
            'friendly_rx_gain': 0,
            f'{p}_lat': 35.0,
            f'{p}_lon': 45.0,
            self.HEIGHT_KEY: 2,
        }
        payload.update(overrides)
        return payload

    def test_flat_terrain_polygon(self):
        with patch.object(elevation, '_fetch_elevations', _flat_elevations):
            data = self.post(self.ENDPOINT, self.make_payload())
        self.assertEqual(data['status'], 'success')
        self.assertGreater(data['base_range_km'], 0)
        # Empty local DTED index -> API resolution path -> 36 bearings.
        self.assertEqual(len(data['polygon_points']), 36)
        for point in data['polygon_points']:
            self.assertEqual(len(point), 2)
            self.assertTrue(-90 <= point[0] <= 90)
            self.assertTrue(-180 <= point[1] <= 180)

    def test_elevation_failure_falls_back_to_null_polygon(self):
        with patch.object(elevation, '_fetch_elevations', _raise_network_error):
            data = self.post(self.ENDPOINT, self.make_payload())
        self.assertEqual(data['status'], 'success')
        self.assertGreater(data['base_range_km'], 0)
        self.assertIsNone(data['polygon_points'])

    def test_validation_rejections(self):
        p = self.PREFIX
        cases = (
            ({'freq_mhz': 0}, 'Frequency'),
            ({f'{p}_tx_w': 0}, 'power'),
            ({f'{p}_lat': 95}, f'Invalid latitude: {p}_lat'),
            ({f'{p}_lon': -200}, f'Invalid longitude: {p}_lon'),
            ({'num_bearings': 0}, 'num_bearings'),
        )
        for overrides, fragment in cases:
            with self.subTest(overrides=overrides):
                data = self.post(self.ENDPOINT, self.make_payload(**overrides))
                self.assertEqual(data['status'], 'error')
                self.assertIn(fragment, data['message'])


class CalculateESTerrainTests(TerrainRingTestMixin, CalcEndpointTestCase):
    ENDPOINT = '/calculate_es_terrain'
    PREFIX = 'enemy'
    TERRAIN_KEY = 'enemy_terrain'
    HEIGHT_KEY = 'tx_antenna_height_m'

    def test_directional_antenna_shrinks_off_boresight(self):
        with patch.object(elevation, '_fetch_elevations', _flat_elevations):
            omni = self.post(self.ENDPOINT, self.make_payload())
            elevation._profile_cache.clear()
            directional = self.post(self.ENDPOINT, self.make_payload(
                tx_antenna_type='directional',
                tx_azimuth_deg=0,
                tx_beamwidth_deg=60,
            ))
        self.assertEqual(directional['status'], 'success')
        # Bearing 180 (index 18) is fully off-boresight: range must shrink
        # relative to the omni ring at the same bearing.
        omni_south = omni['polygon_points'][18]
        dir_south = directional['polygon_points'][18]
        self.assertLess(abs(dir_south[0] - 35.0), abs(omni_south[0] - 35.0))


class CalculateJammerFootprintTests(TerrainRingTestMixin, CalcEndpointTestCase):
    ENDPOINT = '/calculate_jammer_footprint'
    PREFIX = 'jammer'
    TERRAIN_KEY = 'jammer_terrain'
    HEIGHT_KEY = 'jammer_antenna_height_m'

    def test_parity_with_es_terrain(self):
        """Identical physical inputs must produce identical rings on both
        endpoints — locks in that they share one implementation."""
        common = {
            'freq_mhz': 425,
            'rx_sensitivity': -95,
            'friendly_rx_gain': 2,
        }
        es_payload = {
            **common,
            'enemy_terrain': 'rural',
            'enemy_tx_w': 10,
            'enemy_tx_gain': 3,
            'enemy_lat': 35.0,
            'enemy_lon': 45.0,
            'tx_antenna_height_m': 4,
            'tx_antenna_type': 'directional',
            'tx_azimuth_deg': 90,
            'tx_beamwidth_deg': 120,
        }
        fp_payload = {
            **common,
            'jammer_terrain': 'rural',
            'jammer_tx_w': 10,
            'jammer_tx_gain': 3,
            'jammer_lat': 35.0,
            'jammer_lon': 45.0,
            'jammer_antenna_height_m': 4,
            'jammer_antenna_type': 'directional',
            'jammer_azimuth_deg': 90,
            'jammer_beamwidth_deg': 120,
        }
        with patch.object(elevation, '_fetch_elevations', _flat_elevations):
            es_data = self.post('/calculate_es_terrain', es_payload)
            elevation._profile_cache.clear()
            fp_data = self.post('/calculate_jammer_footprint', fp_payload)
        self.assertEqual(es_data['status'], 'success')
        self.assertEqual(fp_data['status'], 'success')
        self.assertEqual(es_data['base_range_km'], fp_data['base_range_km'])
        self.assertEqual(es_data['polygon_points'], fp_data['polygon_points'])


if __name__ == '__main__':
    unittest.main()
