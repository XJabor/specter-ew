import unittest

from core.elevation import check_line_of_sight
from core.link_budget import calculate_eirp, watts_to_dbm
from core.propagation import calculate_path_loss, calculate_received_power


class EaPropagationTests(unittest.TestCase):
    def test_user_80mhz_open_terrain_scenario_is_not_inflated(self):
        freq_mhz = 80.0
        enemy_eirp = calculate_eirp(watts_to_dbm(50.0), 2.0)
        jammer_eirp = calculate_eirp(watts_to_dbm(20.0), 2.0)

        enemy_path_loss = calculate_path_loss(
            7.0, freq_mhz, "rural", 0.0, 1.0, 1.0, False
        )
        jammer_path_loss = calculate_path_loss(
            3.6, freq_mhz, "rural", 0.0, 1.0, 1.0, False
        )

        enemy_rx = calculate_received_power(enemy_eirp, enemy_path_loss) + 2.0
        jammer_rx = calculate_received_power(jammer_eirp, jammer_path_loss) + 2.0

        self.assertAlmostEqual(jammer_rx - enemy_rx, 7.58, places=2)

    def test_smooth_ridge_does_not_stack_as_many_independent_edges(self):
        profile = []
        total_km = 3.6
        ridge_height_m = 50.0
        for i in range(20):
            distance_km = total_km * i / 19
            normalized = abs(distance_km - (total_km / 2.0)) / (total_km / 2.0)
            elevation_m = ridge_height_m * max(0.0, 1.0 - normalized)
            profile.append({
                "lat": 0.0,
                "lon": 0.0,
                "distance_km": distance_km,
                "elevation_m": elevation_m,
            })

        los = check_line_of_sight(profile, 80.0, 1.0, 1.0)

        self.assertFalse(los["is_los"])
        self.assertGreater(los["diffraction_loss_db"], 10.0)
        self.assertLess(los["diffraction_loss_db"], 25.0)


if __name__ == "__main__":
    unittest.main()
