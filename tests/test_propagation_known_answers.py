"""Known-answer validation for core.propagation.calculate_path_loss.

Every expected value below was derived by hand from the published formula
(substitution shown in the comment above each assertion), NOT by running the
code under test. calculate_path_loss() rounds to 2 dp, so a 0.05 dB delta is
used throughout.

Reference formulas
------------------
FSPL (Friis, d km, f MHz):
    L = 20 log10 d + 20 log10 f + 32.44
    (exact constant 20 log10(4*pi*1e9/c) = 32.4478; 32.44 is the textbook
    rounding the code uses; the 0.008 dB gap is inside the tolerance)
Plane-earth two-ray (d m, h m):
    L = 40 log10 d_m - 20 log10 ht - 20 log10 hr
COST-231 Hata (f MHz, hb/hm m, d km), small/medium city a(hm):
    a(hm) = (1.1 log f - 0.7) hm - (1.56 log f - 0.8)
    A     = 46.3 + 33.9 log f - 13.82 log hb - a(hm) + Cm   (Cm = 3 metro)
    B     = 44.9 - 6.55 log hb
    L_u   = A + B log d
    suburban: L_u - 2 [log(f/28)]^2 - 5.4
    open:     L_u - 4.78 (log f)^2 + 18.33 log f - 40.94
4/3-earth radio horizon (h m -> km):
    d_h = sqrt(2 * 8500 * ht / 1000) + sqrt(2 * 8500 * hr / 1000)

Frequently used terms (20 log10 x):
    60 -> 35.5630   80 -> 38.0618   150 -> 43.5218   149.9 -> 43.5160
    450 -> 53.0643  900 -> 59.0849  999.9 -> 59.9991 1000 -> 60.0000
    1500 -> 63.5218 2000 -> 66.0206 2000.1 -> 66.0210 2400 -> 67.6042
    5800 -> 75.2686 2 -> 6.0206     5 -> 13.9794    10 -> 20.0000
    29.9 -> 29.5134 30 -> 29.5424   40 -> 32.0412

Egli (1957), ratio form Pr/Pt = Gt Gr (ht hr / d^2)^2 (40 / f_MHz)^2, in dB
with d km and h m:
    L = 20 log f + 40 log d - 20 log ht - 20 log hr + K,
    K = 40 log10(1000) - 20 log10(40) = 120 - 32.0412 = 87.9588
Imperial cross-check: 117 - 40 log10(1.609344) - 2 x 20 log10(3.28084)
    = 117 - 8.27 - 20.64 = 88.09 (agrees).
Before v1.2.0 the code used 47.39 (the -10 log hm variant's SI constant 76.3
misread as a miles/feet constant); these tests were written against the
published formula and caught it.
"""
import math
import unittest

from core.propagation import calculate_path_loss, calculate_sensing_distance

DELTA = 0.05
LN10 = math.log(10.0)


def _pl(d, f, terrain, diff=0.0, ht=0.0, hr=0.0, los=False):
    return calculate_path_loss(d, f, terrain, diff, ht, hr, los)


# ---------------------------------------------------------------------------
# 1. Egli
# ---------------------------------------------------------------------------
class EgliBranchTests(unittest.TestCase):
    """freq < 1000 MHz, tx < 30 m (or freq < 150 MHz), not free space.
    K = 87.9588 (see module docstring)."""

    def test_60mhz_10km_rural_egli_wins(self):
        # Egli: 35.5630 + 40 log10(10)=40 - 6.0206 - 6.0206 + 87.9588 = 151.4806
        # FSPL: 20 + 35.5630 + 32.44 = 88.0030  -> Egli wins
        # (Egli exceeds plane-earth two-ray 147.96 by 20 log(60/40) = 3.52 dB, as
        # the (40/f)^2 factor requires above 40 MHz.)
        self.assertAlmostEqual(_pl(10.0, 60.0, 'rural', 0.0, 2.0, 2.0, True), 151.48, delta=DELTA)
        # NLOS with zero diffraction is the same model
        self.assertAlmostEqual(_pl(10.0, 60.0, 'rural', 0.0, 2.0, 2.0, False), 151.48, delta=DELTA)

    def test_60mhz_5m_rural_fspl_floor_wins(self):
        # Floor crossover at 2/2 m: 20 log d < 32.44 - 87.9588 + 12.0412 -> d < 6.7 m
        # Egli at 5 m: 35.5630 + 40 log10(0.005)=-92.0412 - 12.0412 + 87.9588 = 19.4394
        # FSPL: -46.0206 + 35.5630 + 32.44 = 21.9824  -> FSPL floor wins
        self.assertAlmostEqual(_pl(0.005, 60.0, 'rural', 0.0, 2.0, 2.0, True), 21.98, delta=DELTA)

    def test_450mhz_5km_light_forest(self):
        # Egli: 53.0643 + 40 log10(5)=27.9588 - 12.0412 + 87.9588 = 156.9407
        # + light-forest correction 8 = 164.9407 ; FSPL 13.9794+53.0643+32.44 = 99.4837
        self.assertAlmostEqual(_pl(5.0, 450.0, 'light forest', 0.0, 2.0, 2.0, True), 164.94, delta=DELTA)

    def test_nlos_adds_diffraction(self):
        # 151.4806 (see above) + 7.3 dB Deygout = 158.7806
        self.assertAlmostEqual(_pl(10.0, 60.0, 'rural', 7.3, 2.0, 2.0, False), 158.78, delta=DELTA)

    def test_los_ignores_diffraction(self):
        self.assertAlmostEqual(_pl(10.0, 60.0, 'rural', 7.3, 2.0, 2.0, True), 151.48, delta=DELTA)


# ---------------------------------------------------------------------------
# 2. Two-Ray
# ---------------------------------------------------------------------------
class TwoRayBranchTests(unittest.TestCase):
    """LOS, freq >= 150 MHz, tx >= 30 m, freq <= 2000, not free space."""

    def test_450mhz_40m_2m_10km(self):
        # 40 log10(10000) = 160 ; -20 log 40 = -32.0412 ; -20 log 2 = -6.0206
        # L = 121.9382 ; FSPL = 20 + 53.0643 + 32.44 = 105.5043 -> two-ray wins
        self.assertAlmostEqual(_pl(10.0, 450.0, 'rural', 0.0, 40.0, 2.0, True), 121.94, delta=DELTA)

    def test_450mhz_1km_fspl_floor_wins(self):
        # two-ray: 120 - 38.0618 = 81.9382 ; FSPL: 0 + 53.0643 + 32.44 = 85.5043
        # (crossover d = 4 pi ht hr / lambda = 4 pi * 80 / 0.6662 = 1.509 km)
        self.assertAlmostEqual(_pl(1.0, 450.0, 'rural', 0.0, 40.0, 2.0, True), 85.50, delta=DELTA)

    def test_two_ray_is_terrain_independent(self):
        # Published two-ray has no clutter term; the code applies none either.
        for terrain in ('rural', 'light forest', 'dense forest'):
            self.assertAlmostEqual(_pl(10.0, 450.0, terrain, 0.0, 40.0, 2.0, True), 121.94, delta=DELTA)


# ---------------------------------------------------------------------------
# 3. COST-231 Hata
# ---------------------------------------------------------------------------
class Cost231HataBranchTests(unittest.TestCase):
    """NLOS, 900 MHz, hb 50 m, hm 1.5 m, 5 km.

    log f = 2.954243, log hb = 1.698970, log d = 0.698970
    a(hm) = (1.1*2.954243 - 0.7)*1.5 - (1.56*2.954243 - 0.8)
          = 3.824501 - 3.808619 = 0.015882
    A     = 46.3 + 100.148838 - 23.479765 - 0.015882 = 122.953191   (Cm = 0)
    B     = 44.9 - 11.128254 = 33.771746
    L_u   = 122.953191 + 33.771746*0.698970 = 122.953191 + 23.605438 = 146.558629
    FSPL  = 13.9794 + 59.0849 + 32.44 = 105.5043 (floor not active)
    """

    def test_open_rural(self):
        # open corr: -4.78*8.727552 + 18.33*2.954243 - 40.94 = -41.717699 + 54.151274 - 40.94 = -28.506425
        # 146.558629 - 28.506425 = 118.052204
        self.assertAlmostEqual(_pl(5.0, 900.0, 'rural', 0.0, 50.0, 1.5, False), 118.05, delta=DELTA)

    def test_light_suburban(self):
        # log(900/28) = 1.507084 ; 2*1.507084^2 = 4.542604 ; +5.4 -> -9.942604
        # 146.558629 - 9.942604 = 136.616025
        self.assertAlmostEqual(_pl(5.0, 900.0, 'light forest', 0.0, 50.0, 1.5, False), 136.62, delta=DELTA)

    def test_dense_urban_cm3(self):
        # Cm = 3 : 146.558629 + 3 = 149.558629
        self.assertAlmostEqual(_pl(5.0, 900.0, 'dense forest', 0.0, 50.0, 1.5, False), 149.56, delta=DELTA)

    def test_nlos_diffraction_added(self):
        # 118.052204 + 12.5 = 130.552204
        self.assertAlmostEqual(_pl(5.0, 900.0, 'rural', 12.5, 50.0, 1.5, False), 130.55, delta=DELTA)


# ---------------------------------------------------------------------------
# 4. Upper-UHF FSPL
# ---------------------------------------------------------------------------
class UpperUhfFsplBranchTests(unittest.TestCase):
    """1000 <= f <= 2000 MHz, tx < 30 m, not free space: FSPL + 0/8/20."""

    # FSPL(5 km, 1500) = 13.9794 + 63.5218 + 32.44 = 109.9412
    def test_rural(self):
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'rural', 0.0, 2.0, 2.0, True), 109.94, delta=DELTA)

    def test_light(self):
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'light forest', 0.0, 2.0, 2.0, True), 117.94, delta=DELTA)

    def test_dense(self):
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'dense forest', 0.0, 2.0, 2.0, True), 129.94, delta=DELTA)

    def test_nlos_adds_diffraction(self):
        # 117.9412 + 4.0 = 121.9412
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'light forest', 4.0, 2.0, 2.0, False), 121.94, delta=DELTA)


# ---------------------------------------------------------------------------
# 5. SHF
# ---------------------------------------------------------------------------
class ShfBranchTests(unittest.TestCase):
    """f > 2000 MHz: FSPL + k f_GHz d + near-ground penalty (+ diffraction NLOS).

    FSPL(1 km, 5800) = 0 + 75.2686 + 32.44 = 107.7086 ; f_GHz = 5.8
    """

    def test_open_is_pure_fspl_even_low(self):
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'rural', 0.0, 2.0, 2.0, True), 107.71, delta=DELTA)

    def test_light_clutter_elevated(self):
        # 107.7086 + 2*5.8*1 = 119.3086 ; both antennas >= 5 m -> no penalty
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'light forest', 0.0, 10.0, 10.0, True), 119.31, delta=DELTA)

    def test_light_clutter_near_ground(self):
        # 119.3086 + 5 = 124.3086
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'light forest', 0.0, 2.0, 2.0, True), 124.31, delta=DELTA)

    def test_dense_clutter_elevated(self):
        # 107.7086 + 5*5.8*1 = 136.7086
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'dense forest', 0.0, 5.0, 5.0, True), 136.71, delta=DELTA)

    def test_dense_near_ground_one_low_antenna(self):
        # min(4.9, 30) < 5 -> +10 : 136.7086 + 10 = 146.7086
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'dense forest', 0.0, 30.0, 4.9, True), 146.71, delta=DELTA)

    def test_nlos_adds_diffraction_as_blockage(self):
        # 136.7086 + 15 = 151.7086 (6 m antennas, no near-ground penalty)
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'dense forest', 15.0, 6.0, 6.0, False), 151.71, delta=DELTA)
        # LOS ignores it
        self.assertAlmostEqual(_pl(1.0, 5800.0, 'dense forest', 15.0, 6.0, 6.0, True), 136.71, delta=DELTA)

    def test_shf_ignores_hata_heights(self):
        # tx 50 m would be Hata-valid below 2 GHz; SHF routing precedes that check.
        # 3 km: FSPL = 9.5424 + 75.2686 + 32.44 = 117.2510 (open, no clutter)
        self.assertAlmostEqual(_pl(3.0, 5800.0, 'rural', 0.0, 50.0, 2.0, False), 117.25, delta=DELTA)


# ---------------------------------------------------------------------------
# 6. Free space
# ---------------------------------------------------------------------------
class FreeSpaceBranchTests(unittest.TestCase):
    def test_150mhz_fspl_regardless_of_heights(self):
        # 20 + 43.5218 + 32.44 = 95.9618 ; tx 50 m would otherwise be Two-Ray/Hata
        self.assertAlmostEqual(_pl(10.0, 150.0, 'free space', 0.0, 50.0, 2.0, True), 95.96, delta=DELTA)
        self.assertAlmostEqual(_pl(10.0, 150.0, 'free space', 0.0, 2.0, 2.0, True), 95.96, delta=DELTA)

    def test_60mhz_free_space_is_not_egli(self):
        # 20 + 35.5630 + 32.44 = 88.0030 (Egli would give 110.91)
        self.assertAlmostEqual(_pl(10.0, 60.0, 'free space', 0.0, 2.0, 2.0, True), 88.00, delta=DELTA)

    def test_1500mhz_free_space_has_no_terrain_correction(self):
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'free space', 0.0, 2.0, 2.0, True), 109.94, delta=DELTA)

    def test_nlos_free_space_still_adds_diffraction(self):
        # 95.9618 + 6 = 101.9618
        self.assertAlmostEqual(_pl(10.0, 150.0, 'free space', 6.0, 2.0, 2.0, False), 101.96, delta=DELTA)

    def test_2400mhz_free_space_routes_to_shf(self):
        # freq > 2000 is checked before free space. Path loss is identical to
        # FSPL (k=0 and no near-ground penalty for 'free_space'):
        # 20 + 67.6042 + 32.44 = 120.0442
        # ...but see SensingDistanceHorizonTests: the SHF sensing inverse applies
        # the radio-horizon cap to free space, the <2 GHz free-space path does not.
        self.assertAlmostEqual(_pl(10.0, 2400.0, 'free space', 0.0, 1.0, 1.0, True), 120.04, delta=DELTA)


# ---------------------------------------------------------------------------
# 7. Terrain deltas
# ---------------------------------------------------------------------------
class TerrainCorrectionDeltaTests(unittest.TestCase):
    def _delta(self, a, b):
        return a - b

    def test_egli_deltas_0_8_20(self):
        r = _pl(10.0, 60.0, 'rural', 0.0, 2.0, 2.0, True)
        self.assertAlmostEqual(_pl(10.0, 60.0, 'light forest', 0.0, 2.0, 2.0, True) - r, 8.0, delta=0.011)
        self.assertAlmostEqual(_pl(10.0, 60.0, 'dense forest', 0.0, 2.0, 2.0, True) - r, 20.0, delta=0.011)

    def test_egli_delta_compressed_in_fspl_floor_region(self):
        # 5 m: rural hits floor 21.9824; light = 19.4394 + 8 = 27.4394
        # delta = 5.4570, NOT 8 (floor applies after correction)
        r = _pl(0.005, 60.0, 'rural', 0.0, 2.0, 2.0, True)
        l = _pl(0.005, 60.0, 'light forest', 0.0, 2.0, 2.0, True)
        self.assertAlmostEqual(l - r, 5.46, delta=DELTA)

    def test_upper_uhf_deltas_0_8_20(self):
        r = _pl(5.0, 1500.0, 'rural', 0.0, 2.0, 2.0, True)
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'light forest', 0.0, 2.0, 2.0, True) - r, 8.0, delta=0.011)
        self.assertAlmostEqual(_pl(5.0, 1500.0, 'dense forest', 0.0, 2.0, 2.0, True) - r, 20.0, delta=0.011)

    def test_shf_clutter_scales_with_f_and_d(self):
        # elevated (10 m) -> no near-ground penalty; delta = k * f_GHz * d
        for f, d in ((5800.0, 1.0), (5800.0, 2.0), (2400.0, 3.0)):
            r = _pl(d, f, 'rural', 0.0, 10.0, 10.0, True)
            self.assertAlmostEqual(_pl(d, f, 'light forest', 0.0, 10.0, 10.0, True) - r,
                                   2.0 * f / 1000.0 * d, delta=0.011)
            self.assertAlmostEqual(_pl(d, f, 'dense forest', 0.0, 10.0, 10.0, True) - r,
                                   5.0 * f / 1000.0 * d, delta=0.011)

    def test_hata_terrain_deltas(self):
        # dense - open = 3 + 28.506425 = 31.506425
        # light - open = 28.506425 - 9.942604 = 18.563821
        r = _pl(5.0, 900.0, 'rural', 0.0, 50.0, 1.5, False)
        self.assertAlmostEqual(_pl(5.0, 900.0, 'dense forest', 0.0, 50.0, 1.5, False) - r, 31.51, delta=DELTA)
        self.assertAlmostEqual(_pl(5.0, 900.0, 'light forest', 0.0, 50.0, 1.5, False) - r, 18.56, delta=DELTA)


# ---------------------------------------------------------------------------
# 8. Branch boundaries
# ---------------------------------------------------------------------------
class BranchBoundaryTests(unittest.TestCase):
    def test_freq_149_9_vs_150_at_30m_los(self):
        # 149.9 -> Egli: 43.5160 + 27.9588 - 29.5424 - 6.0206 + 87.9588 = 123.8706
        #          FSPL: 13.9794 + 43.5160 + 32.44 = 89.9354 -> Egli wins
        self.assertAlmostEqual(_pl(5.0, 149.9, 'rural', 0.0, 30.0, 2.0, True), 123.87, delta=DELTA)
        # 150 -> Two-ray: 147.9588 - 29.5424 - 6.0206 = 112.3958 (11.5 dB drop)
        self.assertAlmostEqual(_pl(5.0, 150.0, 'rural', 0.0, 30.0, 2.0, True), 112.40, delta=DELTA)

    def test_freq_150_nlos_is_hata(self):
        # log f = 2.176091 ; log hb = 1.477121 ; hm = 2
        # a(hm) = (2.393700 - 0.7)*2 - (3.394702 - 0.8) = 3.387400 - 2.594702 = 0.792698
        # A = 46.3 + 73.769485 - 20.413815 - 0.792698 = 98.862972
        # B = 44.9 - 9.675143 = 35.224857 ; B log 5 = 24.621120 -> L_u = 123.484092
        # open: -4.78*4.735372 + 18.33*2.176091 - 40.94 = -23.687330 -> 99.796762
        self.assertAlmostEqual(_pl(5.0, 150.0, 'rural', 0.0, 30.0, 2.0, False), 99.80, delta=DELTA)

    def test_tx_29_9_vs_30_at_450mhz(self):
        # 29.9 m -> Egli: 53.0643 + 27.9588 - 29.5134 - 6.0206 + 87.9588 = 133.4479
        #           FSPL(5, 450) = 99.4837 -> Egli wins
        self.assertAlmostEqual(_pl(5.0, 450.0, 'rural', 0.0, 29.9, 2.0, True), 133.45, delta=DELTA)
        # 30 m -> Two-ray 112.3958 (21.1 dB drop)
        self.assertAlmostEqual(_pl(5.0, 450.0, 'rural', 0.0, 30.0, 2.0, True), 112.40, delta=DELTA)

    def test_999_9_vs_1000_low_antenna(self):
        # 999.9 -> Egli: 59.9991 + 27.9588 - 12.0412 + 87.9588 = 163.8755 (> FSPL 106.4185)
        self.assertAlmostEqual(_pl(5.0, 999.9, 'rural', 0.0, 2.0, 2.0, True), 163.88, delta=DELTA)
        # 1000 -> upper-UHF FSPL: 13.9794 + 60 + 32.44 = 106.4194 (57.5 dB drop —
        # the upper-UHF FSPL branch is far more optimistic than Egli at the seam)
        self.assertAlmostEqual(_pl(5.0, 1000.0, 'rural', 0.0, 2.0, 2.0, True), 106.42, delta=DELTA)

    def test_2000_vs_2000_1_light_low_antenna(self):
        # 2000 -> upper-UHF: 13.9794 + 66.0206 + 32.44 + 8 = 120.4400
        self.assertAlmostEqual(_pl(5.0, 2000.0, 'light forest', 0.0, 2.0, 2.0, True), 120.44, delta=DELTA)
        # 2000.1 -> SHF: FSPL 112.4404 + 2*2.0001*5 (20.001) + 5 = 137.4414 (17 dB jump)
        self.assertAlmostEqual(_pl(5.0, 2000.1, 'light forest', 0.0, 2.0, 2.0, True), 137.44, delta=DELTA)


# ---------------------------------------------------------------------------
# 9. Sensing-distance inverse consistency
# ---------------------------------------------------------------------------
def _tol(slope_db_per_km):
    # distance rounded to 3 dp -> |dd| <= 0.0005 km ; path loss rounded to 2 dp
    # -> +0.005 dB ; plus 0.001 dB slack for float noise.
    return slope_db_per_km * 0.0005 + 0.006


def _slope_log(n_db_per_decade, d_km):
    # d/dd [n log10 d] = n / (d ln 10)
    return n_db_per_decade / (d_km * LN10)


class SensingDistanceInverseTests(unittest.TestCase):
    """Non-capped, non-floor cases: path_loss(sensing_distance) == budget.

    Budget = eirp + rx_gain - rx_sens. Sensing subtracts diffraction from the
    budget, path loss adds it back, so NLOS cases must also close on budget.
    """

    def _check(self, freq, terrain, ht, hr, los, diff, eirp, gain, sens, slope_fn):
        budget = eirp + gain - sens
        d = calculate_sensing_distance(eirp, freq, terrain, gain, sens, diff, ht, hr, los)
        pl = calculate_path_loss(d, freq, terrain, diff if not los else 0.0, ht, hr, los)
        self.assertAlmostEqual(pl, budget, delta=_tol(slope_fn(d)),
                               msg=f'{freq} MHz {terrain} ht={ht} hr={hr} los={los} d={d}')
        return d

    def test_egli_all_terrains(self):
        for terrain in ('rural', 'light forest', 'dense forest'):
            for los, diff in ((True, 0.0), (False, 10.0)):
                with self.subTest(terrain=terrain, los=los):
                    self._check(60.0, terrain, 2.0, 2.0, los, diff, 40.0, 0.0, -90.0,
                                lambda d: _slope_log(40, d))

    def test_egli_hand_distance(self):
        # 130 = 35.5630 + 40 log d - 12.0412 + 87.9588 -> 40 log d = 18.5194
        # d = 10^0.462985 = 2.904 km (FSPL there is 77.3 dB: floor inactive)
        d = calculate_sensing_distance(40.0, 60.0, 'rural', 0.0, -90.0, 0.0, 2.0, 2.0, True)
        self.assertAlmostEqual(d, 2.904, delta=0.002)

    def test_two_ray(self):
        # hand: 40 log d_m = 130 + 32.0412 + 6.0206 = 168.0618 -> d = 15.906 km
        d = self._check(450.0, 'rural', 40.0, 2.0, True, 0.0, 40.0, 0.0, -90.0,
                        lambda d: _slope_log(40, d))
        self.assertAlmostEqual(d, 10 ** (168.0618 / 40) / 1000, delta=0.002)

    def test_hata_all_terrains(self):
        b = 33.771746
        for terrain in ('rural', 'light forest', 'dense forest'):
            with self.subTest(terrain=terrain):
                self._check(900.0, terrain, 50.0, 1.5, False, 5.0, 40.0, 0.0, -100.0,
                            lambda d: _slope_log(b, d))

    def test_free_space_and_upper_uhf_free_space_not_capped(self):
        # 150 MHz: 20 log d = 120 - 43.5218 - 32.44 = 44.0382 -> 159.2 km
        d = self._check(150.0, 'free space', 2.0, 2.0, True, 0.0, 30.0, 0.0, -90.0,
                        lambda d: _slope_log(20, d))
        self.assertGreater(d, 150.0)
        # 1500 MHz free space: 20 log d = 130 - 63.5218 - 32.44 = 34.0382 -> 50.3 km
        # (> 11.66 km horizon for 2 m/2 m -> proves free space is exempt from the cap)
        d = self._check(1500.0, 'free space', 2.0, 2.0, True, 0.0, 40.0, 0.0, -90.0,
                        lambda d: _slope_log(20, d))
        self.assertAlmostEqual(d, 10 ** (34.0382 / 20), delta=0.01)

    def test_upper_uhf_below_horizon(self):
        # 1500 light, 2/2 m: 20 log d = 100 - 8 - 63.5218 - 32.44 = -3.9618 -> 0.634 km < 11.66
        for los, diff in ((True, 0.0), (False, 3.0)):
            with self.subTest(los=los):
                self._check(1500.0, 'light forest', 2.0, 2.0, los, diff, 10.0, 0.0, -90.0,
                            lambda d: _slope_log(20, d))

    def test_shf_below_horizon(self):
        # Horizon 30/30 m = 2 sqrt(510) = 45.17 km ; 2/2 m = 11.66 km.
        cases = (
            ('rural', 30.0, 30.0, 0.0),         # FSPL: 20 log d = 130 - 107.7086 -> 13.0 km
            ('light forest', 30.0, 30.0, 0.0),  # FSPL + 11.6 d = 130 -> ~1.6 km
            ('dense forest', 2.0, 2.0, 0.0),    # FSPL + 29 d = 120 (after 10 dB penalty) -> ~0.58 km
            ('light forest', 30.0, 30.0, 8.0),  # NLOS blockage
        )
        for terrain, ht, hr, diff in cases:
            k = {'light forest': 2.0, 'dense forest': 5.0}.get(terrain, 0.0) * 5.8
            with self.subTest(terrain=terrain, diff=diff):
                self._check(5800.0, terrain, ht, hr, diff == 0.0, diff, 40.0, 0.0, -90.0,
                            lambda d, k=k: _slope_log(20, d) + k)


class SensingDistanceHorizonTests(unittest.TestCase):
    """Cases where the 4/3-earth horizon cap binds: distance == horizon,
    path_loss(horizon) <= budget."""

    def _capped(self, freq, terrain, ht, hr, los, diff, budget, horizon):
        d = calculate_sensing_distance(budget, freq, terrain, 0.0, 0.0, diff, ht, hr, los)
        self.assertAlmostEqual(d, horizon, delta=0.0006)
        pl = calculate_path_loss(d, freq, terrain, 0.0 if los else diff, ht, hr, los)
        self.assertLessEqual(pl, budget)
        return d

    def test_shf_open_2m(self):
        # sqrt(34) + sqrt(34) = 11.6619 km ; uncapped FSPL inverse at 150 dB -> ~130 km
        self._capped(5800.0, 'rural', 2.0, 2.0, True, 0.0, 150.0, 11.6619)

    def test_shf_open_asymmetric_heights(self):
        # sqrt(170) + sqrt(34) = 13.0384 + 5.8310 = 18.8694 km ; 10 m and 2 m
        # open, budget 150: uncapped FSPL inverse 20 log d = 150 - 107.7086 -> 130 km
        self._capped(5800.0, 'rural', 10.0, 2.0, True, 0.0, 150.0, 18.8694)

    def test_upper_uhf_light_los_and_nlos(self):
        # 1500 light 2/2: 20 log d = 150 - 8 - 63.5218 - 32.44 = 46.0382 -> 200 km -> cap 11.6619
        self._capped(1500.0, 'light forest', 2.0, 2.0, True, 0.0, 150.0, 11.6619)
        self._capped(1500.0, 'dense forest', 2.0, 2.0, False, 5.0, 170.0, 11.6619)

    def test_shf_free_space_is_capped_unlike_upper_uhf_free_space(self):
        # FINDING (behavioural inconsistency, not a formula error): 2400 MHz
        # 'free space' (aerial) at 1 m/1 m is capped at 2 sqrt(17) = 8.2462 km,
        # whereas 1500 MHz 'free space' is explicitly exempt from the cap.
        self._capped(2400.0, 'free space', 1.0, 1.0, True, 0.0, 150.0, 8.2462)
        # same budget at 1500 free space: 20 log d = 150 - 63.5218 - 32.44 -> 503 km (uncapped)
        d = calculate_sensing_distance(150.0, 1500.0, 'free space', 0.0, 0.0, 0.0, 1.0, 1.0, True)
        self.assertGreater(d, 500.0)


class SensingDistanceFsplFloorTests(unittest.TestCase):
    """In the region where the FSPL floor (max(fspl, model)) wins, the sensing
    distance must be the FSPL inverse, so path_loss(distance) == budget still
    holds. (Before v1.2.0 the raw model was inverted without the floor and the
    returned range over-shot the budget by 3–6 dB; these tests caught it.)
    """

    def test_egli_high_mast_low_vhf(self):
        # 60 MHz, tx 29 m, rx 10 m, rural, budget 55 dB.
        # Floor crossover: 20 log d < 32.44 - 87.9588 + 20 log 290 -> d < 0.486 km
        # Raw Egli: A = 35.5630 - 29.2480 - 20 + 87.9588 = 74.2738
        #           40 log d = 55 - 74.2738 -> d = 0.3297 km (FSPL there: 57.9 > 55)
        # FSPL inverse: 20 log d = 55 - 35.5630 - 32.44 -> d = 0.2238 km  <- answer
        d = calculate_sensing_distance(55.0, 60.0, 'rural', 0.0, 0.0, 0.0, 29.0, 10.0, True)
        self.assertAlmostEqual(d, 0.224, delta=0.0011)
        pl = calculate_path_loss(d, 60.0, 'rural', 0.0, 29.0, 10.0, True)
        self.assertAlmostEqual(pl, 55.0, delta=_tol(_slope_log(20, d)))

    def test_two_ray_inside_breakpoint(self):
        # 450 MHz 40/2 m, budget 80: 40 log d_m = 118.0618 -> d = 0.894 km
        # FSPL(0.894) = -0.9691 + 53.0643 + 32.44 = 84.54 > 80 (4.5 dB)
        d = calculate_sensing_distance(80.0, 450.0, 'rural', 0.0, 0.0, 0.0, 40.0, 2.0, True)
        pl = calculate_path_loss(d, 450.0, 'rural', 0.0, 40.0, 2.0, True)
        self.assertAlmostEqual(pl, 80.0, delta=_tol(_slope_log(20, d)))

    def test_hata_open_short_range(self):
        # 900 MHz 50/1.5 open, budget 80: log d = (80 - 94.446766)/33.771746 -> d = 0.373 km
        # FSPL(0.373) = -8.5585 + 59.0849 + 32.44 = 82.97 > 80 (3.0 dB)
        d = calculate_sensing_distance(80.0, 900.0, 'rural', 0.0, 0.0, 0.0, 50.0, 1.5, False)
        pl = calculate_path_loss(d, 900.0, 'rural', 0.0, 50.0, 1.5, False)
        self.assertAlmostEqual(pl, 80.0, delta=_tol(_slope_log(20, d)))

    def test_floor_limit_is_reported(self):
        from core.propagation import sensing_distance_breakdown
        floor = sensing_distance_breakdown(55.0, 60.0, 'rural', 0.0, 0.0, 0.0, 29.0, 10.0, True)
        self.assertTrue(floor['fspl_floor_limited'])
        # 2/2 m Egli: floor only below 6.7 m, so a 130 dB budget is model-limited.
        egli = sensing_distance_breakdown(40.0, 60.0, 'rural', 0.0, -90.0, 0.0, 2.0, 2.0, True)
        self.assertFalse(egli['fspl_floor_limited'])


if __name__ == '__main__':
    unittest.main()
