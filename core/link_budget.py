import math

def watts_to_dbm(watts):
    """
    Converts power in Watts to decibel-milliwatts (dBm).
    Rule of Ten: 10 * log10(P_mW)
    """
    if watts <= 0:
        return 0
    milliwatts = watts * 1000
    dbm = 10 * math.log10(milliwatts)
    return round(dbm, 2)

def calculate_eirp(power_dbm, antenna_gain_dbi):
    """
    Calculates Effective Isotropic Radiated Power (EIRP).
    Adds the transmitter power (dBm) to the antenna gain (dBi).
    """
    eirp = power_dbm + antenna_gain_dbi
    return round(eirp, 2)

def apply_hopping_tax(eirp, jammer_bw_khz, target_bw_khz):
    """
    Subtracts the Hopping Tax from the EIRP if the enemy uses frequency hopping.
    Formula: 10 * log10(Total Jamming Bandwidth / Target Channel Width)
    """
    if target_bw_khz >= jammer_bw_khz or target_bw_khz <= 0:
        return eirp # No tax if they aren't hopping or if BW is invalid
    
    hopping_tax = 10 * math.log10(jammer_bw_khz / target_bw_khz)
    adjusted_eirp = eirp - hopping_tax
    return round(adjusted_eirp, 2)