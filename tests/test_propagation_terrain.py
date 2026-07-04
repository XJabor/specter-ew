"""Pins the canonical terrain vocabulary to _classify_terrain() categories.

The UI sends exactly four terrain strings; every propagation branch keys off
the category returned here, so a silent remapping would shift path-loss
results across all bands.
"""
import unittest

from core.propagation import (
    _classify_terrain,
    _egli_terrain_correction_db,
    _shf_near_ground_penalty_db,
)


class ClassifyTerrainTests(unittest.TestCase):
    def test_canonical_ui_values(self):
        self.assertEqual(_classify_terrain('free space'), 'free_space')
        self.assertEqual(_classify_terrain('rural'), 'open')
        self.assertEqual(_classify_terrain('light forest'), 'light')
        self.assertEqual(_classify_terrain('dense forest'), 'dense')

    def test_legacy_synonyms(self):
        self.assertEqual(_classify_terrain('urban'), 'dense')
        self.assertEqual(_classify_terrain('suburban'), 'light')
        self.assertEqual(_classify_terrain('open air'), 'free_space')

    def test_empty_and_none_default_to_open(self):
        self.assertEqual(_classify_terrain(''), 'open')
        self.assertEqual(_classify_terrain(None), 'open')

    def test_flat_corrections_track_categories(self):
        self.assertEqual(_egli_terrain_correction_db('rural'), 0.0)
        self.assertEqual(_egli_terrain_correction_db('light forest'), 8.0)
        self.assertEqual(_egli_terrain_correction_db('dense forest'), 20.0)
        # Near-ground SHF penalty only applies below 5 m AGL
        self.assertEqual(_shf_near_ground_penalty_db(1.0, 1.0, 'dense forest'), 10.0)
        self.assertEqual(_shf_near_ground_penalty_db(1.0, 1.0, 'light forest'), 5.0)
        self.assertEqual(_shf_near_ground_penalty_db(1.0, 1.0, 'rural'), 0.0)
        self.assertEqual(_shf_near_ground_penalty_db(6.0, 6.0, 'dense forest'), 0.0)


if __name__ == '__main__':
    unittest.main()
