"""Golden-snapshot drift detector for the propagation model.

Pins calculate_path_loss() and calculate_sensing_distance() over a grid that
exercises every routing branch (Egli, upper-UHF FSPL, Two-Ray, COST-231 Hata,
SHF, free space) in every terrain category, LOS and NLOS.

Any change to a model's output fails this test. If the change is intentional,
regenerate the fixture and review the diff in code review:

    python -m tests.test_propagation_golden --regenerate
"""

import itertools
import json
import os
import sys
import unittest

from core.propagation import calculate_path_loss, calculate_sensing_distance

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'propagation_golden.json')

FREQS_MHZ = [50.0, 150.0, 450.0, 900.0, 1500.0, 2400.0, 5800.0]
TX_HEIGHTS_M = [1.0, 2.0, 10.0, 30.0, 60.0]
RX_HEIGHTS_M = [1.0, 10.0]
TERRAINS = ['free space', 'rural', 'light forest', 'dense forest']
DISTANCES_KM = [0.5, 5.0, 25.0]
DIFFRACTION_DB = [0.0, 12.5]
EIRPS_DBM = [30.0, 50.0]


def _key(*parts):
    return '|'.join(str(p) for p in parts)


def compute_grid():
    path_loss = {}
    for f, ht, hr, terr, d, diff, los in itertools.product(
            FREQS_MHZ, TX_HEIGHTS_M, RX_HEIGHTS_M, TERRAINS,
            DISTANCES_KM, DIFFRACTION_DB, (True, False)):
        path_loss[_key(f, ht, hr, terr, d, diff, los)] = calculate_path_loss(
            d, f, terr, diff, ht, hr, los)

    sensing = {}
    for f, ht, hr, terr, eirp, diff, los in itertools.product(
            FREQS_MHZ, TX_HEIGHTS_M, RX_HEIGHTS_M, TERRAINS,
            EIRPS_DBM, DIFFRACTION_DB, (True, False)):
        sensing[_key(f, ht, hr, terr, eirp, diff, los)] = calculate_sensing_distance(
            eirp, f, terr, 0.0, -100.0, diff, ht, hr, los)

    return {'path_loss': path_loss, 'sensing_distance': sensing}


class PropagationGoldenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding='utf-8') as fh:
            cls.golden = json.load(fh)
        cls.current = compute_grid()

    def _assert_matches(self, table):
        golden, current = self.golden[table], self.current[table]
        self.assertEqual(set(golden), set(current), f'{table}: grid keys changed')
        drift = [(k, golden[k], current[k]) for k in golden
                 if abs(golden[k] - current[k]) > 1e-9]
        self.assertFalse(
            drift,
            f'{table}: {len(drift)} values drifted from the golden snapshot; '
            f'first few: {drift[:5]}')

    def test_path_loss_matches_golden(self):
        self._assert_matches('path_loss')

    def test_sensing_distance_matches_golden(self):
        self._assert_matches('sensing_distance')


if __name__ == '__main__':
    if '--regenerate' in sys.argv:
        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, 'w', encoding='utf-8') as fh:
            json.dump(compute_grid(), fh, indent=0, sort_keys=True)
        print(f'wrote {FIXTURE}')
    else:
        unittest.main()
