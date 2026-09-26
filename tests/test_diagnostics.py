"""Shape and consistency tests for the optional `diagnostics` blocks added to
the calculation endpoints in v1.2.0, plus elevation provenance tracking.

The diagnostics feed the calculation inspector and the report, so the tests
pin (a) that every field the frontend reads is present, (b) that the
diagnostic numbers are the same numbers the calculation used, and (c) that
the pre-1.2.0 response fields are unchanged.
"""

import os
import re
import unittest
from unittest.mock import patch

import app
import core.elevation as elevation
from core.propagation import (
    MODEL_COST231_HATA, MODEL_EGLI, MODEL_FREE_SPACE, MODEL_FSPL_UPPER_UHF,
    MODEL_SHF, MODEL_TWO_RAY, calculate_path_loss, path_loss_breakdown,
    sensing_distance_breakdown,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _flat_elevations(locations):
    return [0.0] * len(locations)


def _flat_with_one_remote(locations):
    """Real _Elevations result: every sample flat, the first one remote."""
    remote = [i == 0 for i in range(len(locations))]
    return elevation._Elevations([0.0] * len(locations), remote)


class _Client(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        elevation._profile_cache.clear()
        elevation._profile_source.clear()

    def post(self, endpoint, payload):
        response = self.client.post(
            endpoint, json=payload, environ_base={'REMOTE_ADDR': '127.0.0.1'})
        self.assertEqual(response.status_code, 200)
        return response.get_json()


class PathLossBreakdownTests(unittest.TestCase):
    CASES = [
        # (freq, tx_h, terrain, is_los, expected model)
        (5800.0, 2.0, 'dense forest', True, MODEL_SHF),
        (150.0, 2.0, 'free space', False, MODEL_FREE_SPACE),
        (1500.0, 2.0, 'rural', True, MODEL_FSPL_UPPER_UHF),
        (450.0, 40.0, 'rural', True, MODEL_TWO_RAY),
        (450.0, 40.0, 'rural', False, MODEL_COST231_HATA),
        (60.0, 2.0, 'rural', False, MODEL_EGLI),
    ]

    def test_model_reported_for_each_branch(self):
        for freq, h, terrain, los, expected in self.CASES:
            with self.subTest(freq=freq, h=h, terrain=terrain, los=los):
                b = path_loss_breakdown(5.0, freq, terrain, 10.0, h, 2.0, los)
                self.assertEqual(b['model'], expected)
                self.assertEqual(b['loss_db'],
                                 calculate_path_loss(5.0, freq, terrain, 10.0, h, 2.0, los))

    def test_components_sum_to_total(self):
        for freq, h, terrain, los, _ in self.CASES:
            with self.subTest(freq=freq, terrain=terrain, los=los):
                b = path_loss_breakdown(5.0, freq, terrain, 10.0, h, 2.0, los)
                self.assertAlmostEqual(b['base_loss_db'] + b['diffraction_db'],
                                       b['loss_db'], delta=0.011)

    def test_diffraction_ignored_on_los(self):
        b = path_loss_breakdown(5.0, 60.0, 'rural', 15.0, 2.0, 2.0, True)
        self.assertEqual(b['diffraction_db'], 0.0)

    def test_shf_reports_clutter_and_near_ground_penalty(self):
        b = path_loss_breakdown(2.0, 5800.0, 'dense forest', 0.0, 2.0, 2.0, True)
        self.assertAlmostEqual(b['clutter_db'], 5.0 * 5.8 * 2.0, places=2)
        self.assertEqual(b['near_ground_penalty_db'], 10.0)

    def test_fspl_floor_flag(self):
        # Very short Egli path: free-space loss exceeds the Egli estimate.
        self.assertTrue(path_loss_breakdown(0.05, 60.0, 'rural', 0, 2, 2, False)['fspl_floor_applied'])
        self.assertFalse(path_loss_breakdown(20.0, 60.0, 'rural', 0, 2, 2, False)['fspl_floor_applied'])

    def test_zero_distance(self):
        b = path_loss_breakdown(0.0, 150.0, 'rural')
        self.assertEqual(b['loss_db'], 0.0)
        self.assertIsNone(b['model'])


class SensingBreakdownTests(unittest.TestCase):
    def test_horizon_cap_reported(self):
        capped = sensing_distance_breakdown(60.0, 5800.0, 'rural', 0.0, -100.0,
                                            tx_height_m=2.0, rx_height_m=1.0, is_los=True)
        self.assertEqual(capped['model'], MODEL_SHF)
        self.assertTrue(capped['horizon_capped'])
        self.assertEqual(capped['distance_km'], capped['horizon_km'])
        self.assertGreater(capped['uncapped_distance_km'], capped['distance_km'])

    def test_no_cap_on_egli(self):
        b = sensing_distance_breakdown(37.0, 60.0, 'rural', 0.0, -100.0,
                                       tx_height_m=2.0, rx_height_m=2.0)
        self.assertEqual(b['model'], MODEL_EGLI)
        self.assertIsNone(b['horizon_km'])
        self.assertFalse(b['horizon_capped'])
        self.assertEqual(b['budget_db'], 137.0)


class EaDiagnosticsTests(_Client):
    BASE = {
        'freq_mhz': 60, 'enemy_terrain': 'rural', 'jammer_terrain': 'rural',
        'enemy_tx_w': 5, 'enemy_dist_km': 5, 'jammer_tx_w': 50,
        'jammer_dist_km': 3, 'apply_fh': True, 'enemy_bw_khz': 25,
        'jammer_bw_khz': 250,
    }
    COORDS = {'tx_lat': 35.0, 'tx_lon': -117.0, 'rx_lat': 35.045, 'rx_lon': -117.0,
              'jammer_lat': 35.045, 'jammer_lon': -116.967}

    def test_legacy_fields_unchanged(self):
        data = self.post('/calculate_ea', self.BASE)
        for key in ('status', 'enemy_rx_signal', 'jammer_rx_signal', 'margin',
                    'effect', 'jammer_los', 'enemy_los', 'terrain_warnings'):
            self.assertIn(key, data)

    def test_diagnostics_reconcile_with_result(self):
        data = self.post('/calculate_ea', self.BASE)
        d = data['diagnostics']
        for side in ('enemy', 'jammer'):
            p = d[side]
            for key in ('distance_km', 'terrain', 'tx_power_dbm', 'eirp_dbm',
                        'tx_gain_effective_dbi', 'rx_gain_effective_dbi',
                        'path_loss', 'rx_dbm', 'elevation', 'terrain_profile_used'):
                self.assertIn(key, p, f'{side}.{key}')
            self.assertAlmostEqual(
                p['eirp_dbm'] - p['path_loss']['loss_db'] + p['rx_gain_effective_dbi'],
                p['rx_dbm'], delta=0.011)
        self.assertEqual(d['enemy']['rx_dbm'], data['enemy_rx_signal'])
        self.assertEqual(d['jammer']['rx_dbm'], data['jammer_rx_signal'])
        self.assertAlmostEqual(d['jammer']['rx_dbm'] - d['enemy']['rx_dbm'],
                               data['margin'], delta=0.011)
        self.assertEqual(d['enemy']['path_loss']['model'], MODEL_EGLI)

    def test_fh_tax(self):
        d = self.post('/calculate_ea', self.BASE)['diagnostics']['jammer']
        self.assertTrue(d['fh']['applied'])
        self.assertAlmostEqual(d['fh']['tax_db'], 10.0, places=2)
        self.assertAlmostEqual(d['eirp_before_fh_dbm'] - d['eirp_dbm'], 10.0, places=2)

    def test_no_coordinates_means_no_terrain_profile(self):
        d = self.post('/calculate_ea', self.BASE)['diagnostics']
        self.assertFalse(d['bearing_gains_applied'])
        self.assertFalse(d['enemy']['terrain_profile_used'])
        self.assertIsNone(d['enemy']['elevation'])

    def test_elevation_source_reported(self):
        with patch.object(elevation, '_fetch_elevations', _flat_with_one_remote):
            d = self.post('/calculate_ea', {**self.BASE, **self.COORDS})['diagnostics']
        self.assertTrue(d['bearing_gains_applied'])
        self.assertTrue(d['enemy']['terrain_profile_used'])
        self.assertEqual(d['enemy']['elevation']['source'], 'mixed')
        self.assertEqual(d['enemy']['elevation']['remote_samples'], 1)

    def test_cached_profile_keeps_its_source(self):
        with patch.object(elevation, '_fetch_elevations', _flat_with_one_remote):
            self.post('/calculate_ea', {**self.BASE, **self.COORDS})
        # Second call is served from the profile cache; no fetch at all.
        with patch.object(elevation, '_fetch_elevations', side_effect=AssertionError):
            d = self.post('/calculate_ea', {**self.BASE, **self.COORDS})['diagnostics']
        self.assertEqual(d['enemy']['elevation']['source'], 'mixed')


class FootprintDiagnosticsTests(_Client):
    PAYLOAD = {'freq_mhz': 150, 'enemy_terrain': 'rural', 'enemy_tx_w': 5,
               'enemy_lat': 35.0, 'enemy_lon': -117.0, 'rx_sensitivity': -100}

    REQUIRED = ('freq_mhz', 'terrain', 'peak_eirp_dbm', 'rx_sensitivity_dbm',
                'antenna', 'flat_los', 'flat_nlos', 'locally_covered',
                'num_bearings', 'num_samples', 'fallback_circle', 'ranges',
                'bearing_ranges_km', 'blocked_bearings', 'models_used', 'elevation')

    def test_shape_on_flat_terrain(self):
        with patch.object(elevation, '_fetch_elevations', _flat_elevations):
            data = self.post('/calculate_es_terrain', self.PAYLOAD)
        d = data['diagnostics']
        for key in self.REQUIRED:
            self.assertIn(key, d)
        self.assertFalse(d['fallback_circle'])
        self.assertEqual(d['num_bearings'], 36)
        self.assertEqual(len(d['bearing_ranges_km']), 36)
        self.assertEqual(len(data['polygon_points']), 36)
        self.assertLessEqual(d['ranges']['min_km'], d['ranges']['median_km'])
        self.assertLessEqual(d['ranges']['median_km'], d['ranges']['max_km'])
        self.assertEqual(d['blocked_bearings'], 0)
        self.assertEqual(sum(d['models_used'].values()), 36)
        self.assertEqual(d['elevation']['source'], 'unknown')  # plain-list mock

    def test_fallback_circle_flagged(self):
        def boom(locations):
            raise RuntimeError('offline')
        with patch.object(elevation, '_fetch_elevations', boom):
            d = self.post('/calculate_jammer_footprint', {
                'freq_mhz': 150, 'jammer_terrain': 'rural', 'jammer_tx_w': 20,
                'jammer_lat': 35.0, 'jammer_lon': -117.0, 'rx_sensitivity': -90,
            })['diagnostics']
        self.assertTrue(d['fallback_circle'])
        self.assertEqual(d['bearing_ranges_km'], [])
        self.assertEqual(d['ranges']['min_km'], d['flat_los']['distance_km'])


class ElevationSummaryTests(unittest.TestCase):
    def test_sources(self):
        def summary(**kw):
            tally = {'local': 0, 'remote': 0, 'void': 0, 'unknown_paths': 0, 'paths': 1}
            tally.update(kw)
            return elevation.elevation_summary(tally)['source']
        self.assertEqual(summary(paths=0), 'none')
        self.assertEqual(summary(unknown_paths=1), 'unknown')
        self.assertEqual(summary(local=5), 'local')
        self.assertEqual(summary(remote=5), 'remote')
        self.assertEqual(summary(local=4, remote=1), 'mixed')


class AppVersionTests(unittest.TestCase):
    def test_backend_and_frontend_versions_match(self):
        with open(os.path.join(ROOT, 'static', 'js', 'scenario_schema.js'), encoding='utf-8') as fh:
            js = fh.read()
        m = re.search(r"const SPECTER_APP_VERSION = '([^']+)'", js)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), app.APP_VERSION)

    def test_version_is_semver(self):
        self.assertRegex(app.APP_VERSION, r'^\d+\.\d+\.\d+$')


if __name__ == '__main__':
    unittest.main()
