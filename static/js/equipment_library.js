// Specter-EW — equipment profiles, library, builder, and sidebar sync.
// Declarations only: initEquipmentLibraryControls() is called from app_init.js.

const PROFILE_PACK_STORAGE_KEY = 'specter-ew:equipment-profile-packs';

let builtInProfilePack = null;
let userProfilePacks = [];
let profileLoadPromise = null;
let selectedEquipmentNode = null; // { type: 'red'|'blue', id }
let syncingSidebarFromNode = false;
let pendingLibraryPlacement = null; // { team: 'red'|'blue', templateKey }

// ============================================================
// EQUIPMENT PROFILE LIBRARY
// ============================================================

function profileStatus(message, isError = false) {
    const el = document.getElementById('profile-library-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

function loadUserProfilePacks() {
    try {
        const raw = localStorage.getItem(PROFILE_PACK_STORAGE_KEY);
        const packs = raw ? JSON.parse(raw) : [];
        userProfilePacks = Array.isArray(packs)
            ? packs.map(pack => validateProfilePack(pack, { allowJammerProfiles: true }))
            : [];
    } catch (e) {
        console.warn('Profile pack storage reset', e);
        userProfilePacks = [];
    }
}

function saveUserProfilePacks() {
    try {
        localStorage.setItem(PROFILE_PACK_STORAGE_KEY, JSON.stringify(userProfilePacks));
    } catch (e) {
        profileStatus('Could not persist profiles locally.', true);
    }
}

function allProfilePacks() {
    return builtInProfilePack ? [builtInProfilePack, ...userProfilePacks] : [...userProfilePacks];
}

function allProfiles(category = 'all') {
    return allProfilePacks().flatMap(pack => pack.profiles.map(profile => ({
        ...profile,
        pack_id: pack.pack_id,
        pack_name: pack.pack_name,
        built_in: pack.pack_id === 'specter-builtins',
        key: `${pack.pack_id}/${profile.id}`
    }))).filter(profile => category === 'all' || profile.category === category);
}

function findProfile(key) {
    return allProfiles('all').find(profile => profile.key === key);
}

function profileOptionsHtml(category, placeholder) {
    const profiles = allProfiles(category);
    const options = [`<option value="">${escapeHtml(placeholder || 'Select profile...')}</option>`];
    profiles.forEach(profile => {
        const label = profile.built_in ? profile.name : `${profile.name} (${profile.pack_name})`;
        options.push(`<option value="${escapeHtml(profile.key)}">${escapeHtml(label)}</option>`);
    });
    return options.join('');
}

function setInputValue(id, value) {
    if (value == null) return false;
    const el = document.getElementById(id);
    if (!el) return false;
    el.value = value;
    return true;
}

function applyProfileToSidebar(profile, target) {
    if (!profile) return;
    let changed = false;
    if (target === 'ea-radio') {
        changed = setInputValue('freq_mhz', profile.frequency_mhz) || changed;
        changed = setInputValue('enemy_tx_w', profile.tx_power_w) || changed;
        changed = setInputValue('enemy_tx_gain', profile.antenna_gain_dbi) || changed;
        changed = setInputValue('enemy_rx_gain', profile.antenna_gain_dbi) || changed;
        changed = setInputValue('rx_sensitivity', profile.rx_sensitivity_dbm) || changed;
    } else if (target === 'ea-receiver') {
        changed = setInputValue('freq_mhz', profile.frequency_mhz) || changed;
        changed = setInputValue('rx_sensitivity', profile.rx_sensitivity_dbm) || changed;
        changed = setInputValue('friendly_rx_gain', profile.antenna_gain_dbi) || changed;
    } else if (target === 'ea-jammer') {
        changed = setInputValue('freq_mhz', profile.frequency_mhz) || changed;
        changed = setInputValue('jammer_tx_w', profile.tx_power_w) || changed;
        changed = setInputValue('jammer_tx_gain', profile.antenna_gain_dbi) || changed;
    }
    if (changed) {
        updateFrequencyHoppingControls();
        markDirty('Profile applied.');
        recalculateAll();
    }
}

function applyProfileToNode(team, id, profile) {
    const node = findNode(team, id);
    if (!node || !profile) return;
    if (profile.antenna_type) node.antennaType = profile.antenna_type;
    if (profile.beamwidth_deg != null) node.antennaBeamwidth = Number(profile.beamwidth_deg);
    if (profile.antenna_height_m != null) node.antennaHeightAgl = Number(profile.antenna_height_m);
    if (profile.antenna_gain_dbi != null) {
        if (team === 'red') {
            setInputValue('enemy_tx_gain', profile.antenna_gain_dbi);
            setInputValue('enemy_rx_gain', profile.antenna_gain_dbi);
        } else if (team === 'blue') {
            setInputValue('jammer_tx_gain', profile.antenna_gain_dbi);
        }
    }
    rebindNodePopup(team, id);
    node.marker.openPopup();
    markDirty('Antenna profile applied.');
    recalculateAll();
}

function applyProfileToEpSystem(nodeId, sysId, profile, target) {
    const node = epNodes.find(n => n.id === nodeId);
    const sys = node && node.systems.find(s => s.id === sysId);
    if (!sys || !profile) return;
    clearEpNodeRings(node);
    if (target === 'radio') {
        if (profile.frequency_mhz != null) sys.freqMhz = Number(profile.frequency_mhz);
        if (profile.tx_power_w != null) sys.txPowerW = Number(profile.tx_power_w);
        if (profile.antenna_gain_dbi != null) sys.txGainDbi = Number(profile.antenna_gain_dbi);
    } else if (target === 'antenna') {
        if (profile.antenna_type) sys.antennaType = profile.antenna_type;
        if (profile.beamwidth_deg != null) sys.antennaBeamwidth = Number(profile.beamwidth_deg);
        if (profile.antenna_height_m != null) sys.antennaHeightAgl = Number(profile.antenna_height_m);
        if (profile.antenna_gain_dbi != null) sys.txGainDbi = Number(profile.antenna_gain_dbi);
    }
    updateEpWorkbench();
    markDirty('EP profile applied.');
}

function renderProfileControls() {
    const category = document.getElementById('profile-category-filter')?.value || 'radio';
    const librarySelect = document.getElementById('profile-library-select');
    if (librarySelect) librarySelect.innerHTML = profileOptionsHtml(category, 'Select profile...');
    const deleteBtn = document.getElementById('btn-profile-delete');
    const selectedProfile = findProfile(librarySelect?.value);
    if (deleteBtn) deleteBtn.disabled = !selectedProfile || selectedProfile.built_in;

    const radioSelect = document.getElementById('ea-radio-profile-select');
    if (radioSelect) radioSelect.innerHTML = profileOptionsHtml('radio', 'Select radio...');
    const receiverSelect = document.getElementById('ea-receiver-profile-select');
    if (receiverSelect) receiverSelect.innerHTML = profileOptionsHtml('receiver', 'Select receiver...');
    const jammerSelect = document.getElementById('ea-jammer-profile-select');
    if (jammerSelect) jammerSelect.innerHTML = profileOptionsHtml('jammer', 'No built-in jammer profiles');
    // Both system card lists embed template dropdowns, so they refresh together.
    updateEpWorkbench();
    updateRedSystemsWorkbench();
}

function mergeUserProfilePacks(packs) {
    if (!Array.isArray(packs)) return 0;
    let count = 0;
    packs.forEach(pack => {
        const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
        if (normalized.pack_id === 'specter-builtins') {
            throw new Error('Profile pack_id "specter-builtins" is reserved.');
        }
        const existingIdx = userProfilePacks.findIndex(p => p.pack_id === normalized.pack_id);
        if (existingIdx >= 0) userProfilePacks[existingIdx] = normalized;
        else userProfilePacks.push(normalized);
        count++;
    });
    saveUserProfilePacks();
    renderProfileControls();
    renderLibraryControls();
    return count;
}

function saveCurrentProfile() {
    const category = document.getElementById('profile-category-filter')?.value;
    if (!PROFILE_CATEGORIES.includes(category)) {
        profileStatus('Choose a specific category first.', true);
        return;
    }
    const name = prompt('Profile name:');
    if (!name || !name.trim()) return;
    const profile = {
        id: normalizeProfileId(name),
        name: name.trim(),
        category,
        notes: 'User-created profile'
    };
    if (category === 'radio') {
        profile.frequency_mhz = Number(document.getElementById('freq_mhz').value);
        profile.tx_power_w = Number(document.getElementById('enemy_tx_w').value);
        profile.antenna_gain_dbi = Number(document.getElementById('enemy_tx_gain').value);
        profile.rx_sensitivity_dbm = Number(document.getElementById('rx_sensitivity').value);
    } else if (category === 'receiver') {
        profile.frequency_mhz = Number(document.getElementById('freq_mhz').value);
        profile.antenna_gain_dbi = Number(document.getElementById('friendly_rx_gain').value);
        profile.rx_sensitivity_dbm = Number(document.getElementById('rx_sensitivity').value);
    } else if (category === 'jammer') {
        profile.frequency_mhz = Number(document.getElementById('freq_mhz').value);
        profile.tx_power_w = Number(document.getElementById('jammer_tx_w').value);
        profile.antenna_gain_dbi = Number(document.getElementById('jammer_tx_gain').value);
    } else if (category === 'antenna') {
        profile.antenna_gain_dbi = Number(document.getElementById('enemy_tx_gain').value);
        profile.antenna_height_m = 1.5;
        profile.antenna_type = 'omni';
        profile.beamwidth_deg = 360;
    }
    const pack = userProfilePacks.find(p => p.pack_id === 'user-profiles') || {
        schema_version: 1,
        pack_id: 'user-profiles',
        pack_name: 'User Profiles',
        profiles: []
    };
    pack.profiles = pack.profiles.filter(p => p.id !== profile.id);
    pack.profiles.push(profile);
    const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
    const existingIdx = userProfilePacks.findIndex(p => p.pack_id === normalized.pack_id);
    if (existingIdx >= 0) userProfilePacks[existingIdx] = normalized;
    else userProfilePacks.push(normalized);
    saveUserProfilePacks();
    renderProfileControls();
    markDirty('Profile library changed.');
    profileStatus('Profile saved.');
}

function exportUserProfilePack() {
    const pack = {
        schema_version: 1,
        pack_id: 'specter-exported-profiles',
        pack_name: 'SPECTER Exported Profiles',
        profiles: userProfilePacks.flatMap(pack => pack.profiles.map(profile => ({
            ...profile,
            id: normalizeProfileId(`${pack.pack_id}-${profile.id}`)
        })))
    };
    try {
        const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
        const blob = new Blob([JSON.stringify(normalized, null, 2) + '\n'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'specter-equipment-profiles.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        profileStatus('Profile pack exported.');
    } catch (e) {
        profileStatus('No valid user profiles to export.', true);
    }
}

function initProfileControls() {
    if (profileLoadPromise) return profileLoadPromise;
    loadUserProfilePacks();
    profileLoadPromise = fetch('/static/equipment_profiles.json')
        .then(r => {
            if (!r.ok) throw new Error('Built-in profile pack could not be loaded.');
            return r.json();
        })
        .then(pack => {
            builtInProfilePack = validateProfilePack(pack, { allowJammerProfiles: false });
            renderProfileControls();
            profileStatus(`${allProfiles('all').length} profiles loaded.`);
        })
        .catch(e => {
            console.warn('Profile library load failed', e);
            renderProfileControls();
            profileStatus('Built-in profiles unavailable.', true);
        });

    document.getElementById('profile-category-filter')?.addEventListener('change', renderProfileControls);
    document.getElementById('profile-library-select')?.addEventListener('change', function() {
        const profile = findProfile(this.value);
        const deleteBtn = document.getElementById('btn-profile-delete');
        if (deleteBtn) deleteBtn.disabled = !profile || profile.built_in;
    });
    document.getElementById('btn-profile-apply')?.addEventListener('click', function() {
        const profile = findProfile(document.getElementById('profile-library-select')?.value);
        if (!profile) return;
        if (profile.category === 'radio') applyProfileToSidebar(profile, 'ea-radio');
        else if (profile.category === 'receiver') applyProfileToSidebar(profile, 'ea-receiver');
        else if (profile.category === 'jammer') applyProfileToSidebar(profile, 'ea-jammer');
        else profileStatus('Select an antenna from a node popup or EP system.', true);
    });
    document.getElementById('btn-profile-save-current')?.addEventListener('click', saveCurrentProfile);
    document.getElementById('btn-profile-delete')?.addEventListener('click', function() {
        const profile = findProfile(document.getElementById('profile-library-select')?.value);
        if (!profile || profile.built_in) return;
        const pack = userProfilePacks.find(p => p.pack_id === profile.pack_id);
        if (!pack) return;
        pack.profiles = pack.profiles.filter(p => p.id !== profile.id);
        userProfilePacks = userProfilePacks.filter(p => p.profiles.length > 0);
        saveUserProfilePacks();
        renderProfileControls();
        markDirty('Profile library changed.');
        profileStatus('Profile deleted.');
    });
    document.getElementById('btn-profile-export')?.addEventListener('click', exportUserProfilePack);
    document.getElementById('btn-profile-import')?.addEventListener('click', () => document.getElementById('profile-pack-input')?.click());
    document.getElementById('profile-pack-input')?.addEventListener('change', function() {
        const file = this.files && this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const pack = JSON.parse(reader.result);
                mergeUserProfilePacks([pack]);
                markDirty('Profile pack imported.');
                profileStatus('Profile pack imported.');
            } catch (e) {
                profileStatus(e.message, true);
                alert('Could not import profile pack: ' + e.message);
            }
        };
        reader.readAsText(file);
    });
    document.querySelectorAll('[data-profile-apply]').forEach(select => {
        select.addEventListener('change', function() {
            const profile = findProfile(this.value);
            if (profile) applyProfileToSidebar(profile, this.dataset.profileApply);
            this.value = '';
        });
    });
    return profileLoadPromise;
}

window.applyNodeAntennaProfile = function(team, id, key) {
    const profile = findProfile(key);
    if (profile) applyProfileToNode(team, id, profile);
};

window.applyEpProfile = function(nodeId, sysId, key, target) {
    const profile = findProfile(key);
    if (profile) applyProfileToEpSystem(nodeId, sysId, profile, target);
};

function allNodeTemplates(role = 'all') {
    return allProfilePacks().flatMap(pack => (pack.templates || pack.profiles || []).map(template => ({
        ...template,
        pack_id: pack.pack_id,
        pack_name: pack.pack_name,
        built_in: pack.pack_id === 'specter-builtins',
        key: `${pack.pack_id}/${template.id}`
    }))).filter(template => {
        if (template.equipment_type === 'antenna') return false;
        if (role === 'all') return true;
        const target = role === 'red' ? 'enemy' : 'friendly';
        return (template.role_compatibility || ['enemy', 'friendly']).includes(target);
    });
}

function findNodeTemplate(key) {
    return allNodeTemplates('all').find(template => template.key === key);
}

function epSystemTemplateOptionsHtml() {
    const templates = allNodeTemplates('all').filter(template => template.equipment_type !== 'jammer');
    return ['<option value="">Select system...</option>'].concat(templates.map(template => {
        const source = template.built_in ? 'Built-in' : template.pack_name;
        return `<option value="${escapeHtml(template.key)}">${escapeHtml(template.name)} - ${escapeHtml(source)}</option>`;
    })).join('');
}

function isReceiverCapableEquipment(equipment) {
    if (!equipment) return false;
    return equipment.equipment_type === 'receiver'
        || equipment.equipment_type === 'radio'
        || !!equipment.receiver_capable;
}

function isReceiverCapableNode(node, type = 'blue') {
    return isReceiverCapableEquipment(nodeEquipment(node, type));
}

function isJammerEquipment(equipment) {
    return equipment?.equipment_type === 'jammer';
}

function isJammerNode(node, type = 'blue') {
    return isJammerEquipment(nodeEquipment(node, type));
}

function frequenciesCompatible(a, b) {
    return Math.abs(Number(a) - Number(b)) <= 0.001;
}

function equipmentFromTemplate(template) {
    return {
        template_id: template?.key || '',
        name: template?.name || '',
        equipment_type: template?.equipment_type || 'radio',
        frequency_mhz: Number(template?.frequency_mhz ?? 150),
        tx_power_w: Number(template?.tx_power_w ?? 5),
        rx_sensitivity_dbm: Number(template?.rx_sensitivity_dbm ?? -90),
        antenna_gain_dbi: Number(template?.antenna_gain_dbi ?? 0),
        rx_gain_dbi: Number(template?.rx_gain_dbi ?? template?.antenna_gain_dbi ?? 0),
        antenna_type: template?.antenna_type || 'omni',
        beamwidth_deg: Number(template?.beamwidth_deg ?? 360),
        antenna_height_m: Number(template?.antenna_height_m ?? 1),
        receiver_capable: !!template?.receiver_capable,
        notes: template?.notes || '',
        source_url: template?.source_url || ''
    };
}

function currentFhDefaults() {
    return {
        apply_fh: !!document.getElementById('fh_toggle')?.checked,
        channel_bw_khz: Number(document.getElementById('enemy_bw_khz')?.value || 25),
        jammer_bw_khz: Number(document.getElementById('jammer_bw_khz')?.value || 20000)
    };
}

function equipmentFromSidebar(type) {
    const fh = currentFhDefaults();
    if (type === 'blue') {
        return {
            template_id: '',
            name: '',
            equipment_type: 'jammer',
            frequency_mhz: Number(document.getElementById('freq_mhz').value || 150),
            tx_power_w: Number(document.getElementById('jammer_tx_w').value || 20),
            rx_sensitivity_dbm: Number(document.getElementById('rx_sensitivity').value || DEFAULT_GENERIC_FRIENDLY_SENSOR_SENSITIVITY_DBM),
            antenna_gain_dbi: Number(document.getElementById('jammer_tx_gain').value || 0),
            rx_gain_dbi: Number(document.getElementById('friendly_rx_gain').value || 0),
            antenna_type: 'omni',
            beamwidth_deg: 360,
            antenna_height_m: 1,
            receiver_capable: true,
            apply_fh: false,
            channel_bw_khz: fh.channel_bw_khz,
            jammer_bw_khz: fh.jammer_bw_khz
        };
    }
    return {
        template_id: '',
        name: '',
        equipment_type: 'radio',
        frequency_mhz: Number(document.getElementById('freq_mhz').value || 150),
        tx_power_w: Number(document.getElementById('enemy_tx_w').value || 5),
        rx_sensitivity_dbm: Number(document.getElementById('rx_sensitivity').value || -90),
        antenna_gain_dbi: Number(document.getElementById('enemy_tx_gain').value || 0),
        rx_gain_dbi: Number(document.getElementById('enemy_rx_gain').value || 0),
        antenna_type: 'omni',
        beamwidth_deg: 360,
        antenna_height_m: 1,
        receiver_capable: false,
        apply_fh: fh.apply_fh,
        channel_bw_khz: fh.channel_bw_khz,
        jammer_bw_khz: fh.jammer_bw_khz
    };
}

function normalizeEquipmentConfig(equipment, type = 'red') {
    const defaults = equipmentFromSidebar(type);
    const merged = { ...defaults, ...(equipment || {}) };
    merged.equipment_type = PROFILE_CATEGORIES.includes(merged.equipment_type) ? merged.equipment_type : defaults.equipment_type;
    merged.frequency_mhz = Number(merged.frequency_mhz || defaults.frequency_mhz);
    merged.tx_power_w = Number(merged.tx_power_w || defaults.tx_power_w);
    merged.rx_sensitivity_dbm = Number(merged.rx_sensitivity_dbm ?? defaults.rx_sensitivity_dbm);
    merged.antenna_gain_dbi = Number(merged.antenna_gain_dbi ?? defaults.antenna_gain_dbi);
    merged.rx_gain_dbi = Number(merged.rx_gain_dbi ?? merged.antenna_gain_dbi ?? defaults.rx_gain_dbi);
    merged.antenna_type = merged.antenna_type === 'directional' ? 'directional' : 'omni';
    merged.beamwidth_deg = Math.max(1, Math.min(360, Number(merged.beamwidth_deg || defaults.beamwidth_deg)));
    merged.antenna_height_m = Math.max(1, Number(merged.antenna_height_m || defaults.antenna_height_m));
    merged.receiver_capable = !!merged.receiver_capable;
    merged.apply_fh = !!merged.apply_fh;
    merged.channel_bw_khz = Math.max(0.001, Number(merged.channel_bw_khz || defaults.channel_bw_khz || 25));
    merged.jammer_bw_khz = Math.max(0.001, Number(merged.jammer_bw_khz || defaults.jammer_bw_khz || 20000));
    return merged;
}

function applyEquipmentToNode(node, equipment, type) {
    node.equipment = normalizeEquipmentConfig(equipment, type);
    node.antennaType = node.equipment.antenna_type;
    node.antennaBeamwidth = node.equipment.beamwidth_deg;
    node.antennaHeightAgl = node.equipment.antenna_height_m;
    if (type === 'blue' && !isReceiverCapableEquipment(node.equipment)) {
        node.sensorActive = false;
        clearSensorCoverage(node);
    }
    if (type === 'blue' && !isJammerEquipment(node.equipment)) {
        node.footprintActive = false;
        clearBlueFootprint(node);
    }
}

function nodeEquipment(node, type) {
    if (!node.equipment) applyEquipmentToNode(node, equipmentFromSidebar(type), type);
    return node.equipment;
}

function equipmentScenarioState(node, type) {
    return normalizeEquipmentConfig(nodeEquipment(node, type), type);
}

function frequencyLockedForEquipment(equipmentType) {
    return equipmentType === 'receiver' || equipmentType === 'jammer';
}

function updateSidebarFrequencyLock(equipmentType) {
    const input = document.getElementById('freq_mhz');
    const label = document.getElementById('freq-label');
    const note = document.getElementById('freq-lock-note');
    if (!input || !label) return;
    const locked = frequencyLockedForEquipment(equipmentType);
    input.disabled = locked;
    if (note) note.style.display = locked ? 'block' : 'none';
    if (equipmentType === 'jammer') label.textContent = 'Target Frequency (MHz)';
    else if (equipmentType === 'receiver') label.textContent = 'Reference Frequency (MHz)';
    else label.textContent = 'Frequency (MHz)';
}

function updateBuilderFrequencyLock() {
    const type = document.getElementById('builder-equipment-type')?.value || 'radio';
    const input = document.getElementById('builder-frequency');
    const label = document.getElementById('builder-frequency-label');
    const note = document.getElementById('builder-frequency-note');
    if (!input || !label) return;
    const locked = frequencyLockedForEquipment(type);
    input.disabled = locked;
    if (note) note.style.display = locked ? 'block' : 'none';
    if (type === 'jammer') label.textContent = 'Target MHz';
    else if (type === 'receiver') label.textContent = 'Reference MHz';
    else label.textContent = 'Freq MHz';
}

function updateReceiverFieldLabels(type, equipment) {
    const sensitivityRow = document.getElementById('rx-sensitivity-row');
    const sensitivityLabel = document.getElementById('rx-sensitivity-label');
    const gainRow = document.getElementById('friendly-rx-gain-row');
    const gainLabel = document.getElementById('friendly-rx-gain-label');
    const footprintRow = document.getElementById('footprint-rx-sensitivity-row');
    const receiverCapable = type === 'red' || isReceiverCapableEquipment(equipment);
    const jammerCapable = type === 'blue' && isJammerEquipment(equipment);

    if (sensitivityRow) sensitivityRow.style.display = receiverCapable ? '' : 'none';
    if (gainRow) gainRow.style.display = receiverCapable && type === 'blue' ? '' : 'none';
    if (footprintRow) footprintRow.style.display = jammerCapable ? '' : 'none';
    if (sensitivityLabel) {
        sensitivityLabel.textContent = type === 'red' ? 'Target Rx Sensitivity (dBm)' : 'Sensor Rx Sensitivity (dBm)';
    }
    if (gainLabel) {
        gainLabel.textContent = type === 'red' ? 'Target Rx Ant Gain (dBi)' : 'Sensor Rx Ant Gain (dBi)';
    }
}

function updateDefaultSidebarContext() {
    updateSidebarFrequencyLock('radio');
    updateReceiverFieldLabels('blue', { equipment_type: 'jammer', receiver_capable: true });
    const sensitivity = document.getElementById('rx_sensitivity');
    if (sensitivity) sensitivity.value = DEFAULT_GENERIC_FRIENDLY_SENSOR_SENSITIVITY_DBM;
}

function populateSidebarFromNode(type, node) {
    if (!node) return;
    const equipment = nodeEquipment(node, type);
    syncingSidebarFromNode = true;
    document.getElementById('freq_mhz').value = equipment.frequency_mhz;
    document.getElementById('rx_sensitivity').value = equipment.rx_sensitivity_dbm;
    document.getElementById('fh_toggle').checked = !!equipment.apply_fh;
    document.getElementById('enemy_bw_khz').value = equipment.channel_bw_khz;
    document.getElementById('jammer_bw_khz').value = equipment.jammer_bw_khz;
    updateFrequencyHoppingControls();
    if (type === 'red') {
        document.getElementById('enemy_tx_w').value = equipment.tx_power_w;
        document.getElementById('enemy_tx_gain').value = equipment.antenna_gain_dbi;
        document.getElementById('enemy_rx_gain').value = equipment.rx_gain_dbi;
    } else {
        document.getElementById('jammer_tx_w').value = equipment.tx_power_w;
        document.getElementById('jammer_tx_gain').value = equipment.antenna_gain_dbi;
        document.getElementById('friendly_rx_gain').value = equipment.rx_gain_dbi;
    }
    syncingSidebarFromNode = false;
    updateSidebarFrequencyLock(equipment.equipment_type);
    updateReceiverFieldLabels(type, equipment);
    const status = document.getElementById('selected-node-status');
    if (status) status.textContent = `Editing ${type === 'red' ? 'Enemy' : 'Friendly'} ${node.name}: ${equipment.name || equipment.equipment_type}`;
}

function selectEquipmentNode(type, id) {
    const node = findNode(type, id);
    if (!node || (type !== 'red' && type !== 'blue')) return;
    selectedEquipmentNode = { type, id };
    if (type === 'blue' && isReceiverCapableNode(node, 'blue')) selectedSensorNodeId = id;
    populateSidebarFromNode(type, node);
}

function syncSelectedNodeFromSidebar(changedId) {
    if (syncingSidebarFromNode || !selectedEquipmentNode) return false;
    const node = findNode(selectedEquipmentNode.type, selectedEquipmentNode.id);
    if (!node) return false;
    const equipment = nodeEquipment(node, selectedEquipmentNode.type);
    if (changedId === 'freq_mhz') {
        if (frequencyLockedForEquipment(equipment.equipment_type)) return false;
        equipment.frequency_mhz = Number(document.getElementById('freq_mhz').value || equipment.frequency_mhz);
    }
    if (changedId === 'rx_sensitivity') equipment.rx_sensitivity_dbm = Number(document.getElementById('rx_sensitivity').value || equipment.rx_sensitivity_dbm);
    if (changedId === 'fh_toggle') equipment.apply_fh = !!document.getElementById('fh_toggle').checked;
    if (changedId === 'enemy_bw_khz') equipment.channel_bw_khz = Math.max(0.001, Number(document.getElementById('enemy_bw_khz').value || equipment.channel_bw_khz));
    if (changedId === 'jammer_bw_khz') equipment.jammer_bw_khz = Math.max(0.001, Number(document.getElementById('jammer_bw_khz').value || equipment.jammer_bw_khz));
    if (selectedEquipmentNode.type === 'red') {
        if (changedId === 'enemy_tx_w') equipment.tx_power_w = Number(document.getElementById('enemy_tx_w').value || equipment.tx_power_w);
        if (changedId === 'enemy_tx_gain') equipment.antenna_gain_dbi = Number(document.getElementById('enemy_tx_gain').value || equipment.antenna_gain_dbi);
        if (changedId === 'enemy_rx_gain') equipment.rx_gain_dbi = Number(document.getElementById('enemy_rx_gain').value || equipment.rx_gain_dbi);
    } else {
        if (changedId === 'jammer_tx_w') equipment.tx_power_w = Number(document.getElementById('jammer_tx_w').value || equipment.tx_power_w);
        if (changedId === 'jammer_tx_gain') equipment.antenna_gain_dbi = Number(document.getElementById('jammer_tx_gain').value || equipment.antenna_gain_dbi);
        if (changedId === 'friendly_rx_gain') equipment.rx_gain_dbi = Number(document.getElementById('friendly_rx_gain').value || equipment.rx_gain_dbi);
    }
    applyEquipmentToNode(node, equipment, selectedEquipmentNode.type);
    rebindNodePopup(selectedEquipmentNode.type, node.id);
    return true;
}

function renderLibraryControls() {
    const role = document.getElementById('library-role-select')?.value || 'red';
    const select = document.getElementById('library-template-select');
    if (!select) return;
    const previous = select.value;
    const templates = allNodeTemplates(role);
    select.innerHTML = ['<option value="">Select template...</option>'].concat(templates.map(template => {
        const source = template.built_in ? 'Built-in' : template.pack_name;
        return `<option value="${escapeHtml(template.key)}">${escapeHtml(template.name)} - ${escapeHtml(source)}</option>`;
    })).join('');
    if (templates.some(t => t.key === previous)) select.value = previous;
    renderLibraryDetails();
}

function renderLibraryDetails() {
    const template = findNodeTemplate(document.getElementById('library-template-select')?.value);
    const details = document.getElementById('library-template-details');
    const deleteBtn = document.getElementById('btn-delete-library-template');
    if (deleteBtn) deleteBtn.disabled = !template || template.built_in;
    if (!details) return;
    if (!template) {
        details.textContent = 'Select a template to place it on the map.';
        return;
    }
    details.innerHTML = `${escapeHtml(template.equipment_type)} | ${escapeHtml(template.frequency_mhz || '')} MHz | ${escapeHtml(template.tx_power_w || '')} W<br>${escapeHtml(template.notes || '')}`;
}

function saveUserLibrary() {
    saveUserProfilePacks();
    renderLibraryControls();
}

function scenarioProfileLibraryState() {
    return { packs: userProfilePacks.map(pack => ({ ...pack, profiles: undefined })) };
}

function saveBuilderTemplate() {
    const name = document.getElementById('builder-name').value.trim();
    if (!name) {
        libraryStatus('Template name is required.', true);
        return;
    }
    const roleValue = document.getElementById('builder-role-compatibility').value;
    const roles = roleValue === 'enemy' ? ['enemy'] : roleValue === 'friendly' ? ['friendly'] : ['enemy', 'friendly'];
    const template = {
        id: normalizeProfileId(name),
        name,
        role_compatibility: roles,
        equipment_type: document.getElementById('builder-equipment-type').value,
        frequency_mhz: Number(document.getElementById('builder-frequency').value),
        tx_power_w: Number(document.getElementById('builder-power').value),
        rx_sensitivity_dbm: Number(document.getElementById('builder-rx-sensitivity').value),
        antenna_gain_dbi: Number(document.getElementById('builder-antenna-gain').value),
        antenna_type: document.getElementById('builder-antenna-type').value,
        beamwidth_deg: Number(document.getElementById('builder-beamwidth').value),
        antenna_height_m: Number(document.getElementById('builder-height').value),
        apply_fh: document.getElementById('builder-apply-fh').value === 'true',
        channel_bw_khz: Number(document.getElementById('builder-channel-bw').value),
        jammer_bw_khz: Number(document.getElementById('builder-jammer-bw').value),
        notes: document.getElementById('builder-notes').value.trim()
    };
    const pack = userProfilePacks.find(p => p.pack_id === 'user-node-templates') || {
        schema_version: 2,
        pack_id: 'user-node-templates',
        pack_name: 'User Node Templates',
        templates: [],
        profiles: []
    };
    pack.templates = (pack.templates || []).filter(t => t.id !== template.id);
    pack.templates.push(template);
    const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
    const idx = userProfilePacks.findIndex(p => p.pack_id === normalized.pack_id);
    if (idx >= 0) userProfilePacks[idx] = normalized;
    else userProfilePacks.push(normalized);
    saveUserLibrary();
    markDirty('Library template saved.');
    libraryStatus('Template saved.');
}

function libraryStatus(message, isError = false) {
    const el = document.getElementById('library-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

function startLibraryPlacement() {
    const templateKey = document.getElementById('library-template-select')?.value;
    const role = document.getElementById('library-role-select')?.value || 'red';
    const template = findNodeTemplate(templateKey);
    if (!template) {
        libraryStatus('Select a template first.', true);
        return;
    }
    pendingLibraryPlacement = { team: role, templateKey };
    setMode(role === 'red' ? 'place-library-red' : 'place-library-blue');
    libraryStatus(`Click the map to place ${template.name}.`);
}

function exportUserLibrary() {
    const pack = {
        schema_version: 2,
        pack_id: 'specter-exported-node-templates',
        pack_name: 'SPECTER Exported Node Templates',
        templates: userProfilePacks.flatMap(pack => (pack.templates || []).map(template => ({
            ...template,
            id: normalizeProfileId(`${pack.pack_id}-${template.id}`)
        })))
    };
    try {
        const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
        const blob = new Blob([JSON.stringify({ ...normalized, profiles: undefined }, null, 2) + '\n'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'specter-node-library.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        libraryStatus('Library exported.');
    } catch (e) {
        libraryStatus('No user templates to export.', true);
    }
}

function initEquipmentLibraryControls() {
    initProfileControls();
    document.querySelectorAll('.workbench-tab').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.workbench-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.workbench-tab-panel').forEach(panel => panel.classList.remove('active'));
            this.classList.add('active');
            document.getElementById(`tab-${this.dataset.workbenchTab}`)?.classList.add('active');
        });
    });
    document.getElementById('btn-about-support')?.addEventListener('click', () => {
        document.querySelector('.workbench-tab[data-workbench-tab="about"]')?.click();
    });
    document.getElementById('library-role-select')?.addEventListener('change', renderLibraryControls);
    document.getElementById('library-template-select')?.addEventListener('change', renderLibraryDetails);
    document.getElementById('builder-equipment-type')?.addEventListener('change', updateBuilderFrequencyLock);
    document.getElementById('btn-place-library-node')?.addEventListener('click', startLibraryPlacement);
    document.getElementById('btn-builder-save')?.addEventListener('click', saveBuilderTemplate);
    document.getElementById('btn-library-export')?.addEventListener('click', exportUserLibrary);
    document.getElementById('btn-library-import')?.addEventListener('click', () => document.getElementById('library-pack-input')?.click());
    document.getElementById('library-pack-input')?.addEventListener('change', function() {
        const file = this.files && this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const pack = JSON.parse(reader.result);
                mergeUserProfilePacks([pack]);
                renderLibraryControls();
                markDirty('Library imported.');
                libraryStatus('Library imported.');
            } catch (e) {
                libraryStatus(e.message, true);
            }
        };
        reader.readAsText(file);
    });
    document.getElementById('btn-delete-library-template')?.addEventListener('click', function() {
        const template = findNodeTemplate(document.getElementById('library-template-select')?.value);
        if (!template || template.built_in) return;
        const pack = userProfilePacks.find(p => p.pack_id === template.pack_id);
        if (!pack) return;
        pack.templates = (pack.templates || []).filter(t => t.id !== template.id);
        pack.profiles = pack.templates;
        userProfilePacks = userProfilePacks.filter(p => (p.templates || []).length > 0);
        saveUserLibrary();
        markDirty('Library template deleted.');
        libraryStatus('Template deleted.');
    });
    profileLoadPromise?.then(renderLibraryControls);
    updateBuilderFrequencyLock();
    updateDefaultSidebarContext();
}

// ============================================================
// FH TOGGLE
// ============================================================

function updateFrequencyHoppingControls() {
    const displayState = document.getElementById('fh_toggle').checked ? 'block' : 'none';
    document.getElementById('enemy_bw_container').style.display = displayState;
    document.getElementById('jammer_bw_container').style.display = displayState;
}
