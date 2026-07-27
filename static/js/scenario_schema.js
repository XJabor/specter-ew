// Specter-EW — scenario schema (pure logic, no DOM/Leaflet).
// Loaded first; also loadable in Node for unit tests (see tests/js/).
// Scenario/profile-pack validation, migration, and serialization helpers.

const SCENARIO_SCHEMA_VERSION = 5;
const SPECTER_APP_VERSION = 'release-1-dev';

const PROFILE_CATEGORIES = ['radio', 'receiver', 'jammer', 'antenna'];
const PROFILE_NUMERIC_RANGES = {
    frequency_mhz:      [1, 40000],
    tx_power_w:         [0.001, 1000000],
    antenna_gain_dbi:   [-60, 80],
    rx_sensitivity_dbm: [-200, 0],
    antenna_height_m:   [1, 500],
    beamwidth_deg:      [1, 360],
    channel_bw_khz:     [0.001, 10000000],
    jammer_bw_khz:      [0.001, 10000000]
};

function scenarioNow() {
    return new Date().toISOString();
}

function latLngToPlain(latlng) {
    return { lat: latlng.lat, lon: latlng.lng };
}

function validateScenario(data) {
    if (!data || typeof data !== 'object') throw new Error('Scenario file is not valid JSON.');
    if (data.schema_version == null) throw new Error('Scenario is missing schema_version.');
    if (Number(data.schema_version) > SCENARIO_SCHEMA_VERSION) {
        throw new Error(`Scenario schema v${data.schema_version} is newer than this app supports.`);
    }
    if (!data.nodes || typeof data.nodes !== 'object') throw new Error('Scenario is missing nodes.');
    if (!data.links || typeof data.links !== 'object') throw new Error('Scenario is missing links.');
    ['red', 'blue', 'black', 'ep'].forEach(kind => {
        const items = data.nodes[kind] || [];
        if (!Array.isArray(items)) throw new Error(`Scenario nodes.${kind} must be an array.`);
        items.forEach(item => {
            if (!item.id || !item.location) throw new Error(`Scenario ${kind} node is missing id or location.`);
            const lat = Number(item.location.lat);
            const lon = Number(item.location.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                throw new Error(`Scenario ${kind} node ${item.id} has an invalid location.`);
            }
        });
    });
    if (!Array.isArray(data.links.enemy || [])) throw new Error('Scenario links.enemy must be an array.');
    if (!Array.isArray(data.links.jamming || [])) throw new Error('Scenario links.jamming must be an array.');
    if (data.profile_library != null) {
        if (!data.profile_library || typeof data.profile_library !== 'object') throw new Error('Scenario profile_library must be an object.');
        if (!Array.isArray(data.profile_library.packs || [])) throw new Error('Scenario profile_library.packs must be an array.');
        (data.profile_library.packs || []).forEach(pack => validateProfilePack(pack, { allowJammerProfiles: true }));
    }
    return true;
}

// v4 -> v5: red nodes gained a `systems` array of extra ring-only emitters.
// Purely additive, but every older branch must funnel through here rather than
// stamping SCENARIO_SCHEMA_VERSION itself, or it would claim v5 without the field.
function migrateV4ToV5(data) {
    return {
        ...data,
        schema_version: 5,
        nodes: {
            ...data.nodes,
            red: (data.nodes?.red || []).map(node => ({
                ...node,
                systems: Array.isArray(node.systems) ? node.systems : []
            }))
        }
    };
}

function migrateScenario(data) {
    validateScenario(data);
    if (Number(data.schema_version) === SCENARIO_SCHEMA_VERSION) return data;
    if (Number(data.schema_version) === 4) return migrateV4ToV5(data);
    if (Number(data.schema_version) === 3) {
        return migrateV4ToV5({
            ...data,
            schema_version: 4,
            nodes: {
                ...data.nodes,
                red: (data.nodes?.red || []).map(node => ({ ...node, es_active: !!node.es_active })),
                blue: (data.nodes?.blue || []).map(node => ({ ...node, sensor_active: !!node.sensor_active }))
            },
            profile_library: data.profile_library || { packs: [] }
        });
    }
    if ([1, 2].includes(Number(data.schema_version))) {
        const settings = data.settings || {};
        const redEquipment = {
            equipment_type: 'radio',
            frequency_mhz: Number(settings.freq_mhz || 150),
            tx_power_w: Number(settings.enemy_tx_w || 5),
            rx_sensitivity_dbm: Number(settings.rx_sensitivity || -90),
            antenna_gain_dbi: Number(settings.enemy_tx_gain || 0),
            rx_gain_dbi: Number(settings.enemy_rx_gain || 0),
            antenna_type: 'omni',
            beamwidth_deg: 360,
            antenna_height_m: 1,
            receiver_capable: false,
            apply_fh: !!settings.fh_toggle,
            channel_bw_khz: Number(settings.enemy_bw_khz || 25),
            jammer_bw_khz: Number(settings.jammer_bw_khz || 20000)
        };
        const blueEquipment = {
            equipment_type: 'jammer',
            frequency_mhz: Number(settings.freq_mhz || 150),
            tx_power_w: Number(settings.jammer_tx_w || 20),
            rx_sensitivity_dbm: Number(settings.rx_sensitivity || -90),
            antenna_gain_dbi: Number(settings.jammer_tx_gain || 3),
            rx_gain_dbi: Number(settings.friendly_rx_gain || 0),
            antenna_type: 'omni',
            beamwidth_deg: 360,
            antenna_height_m: 1,
            receiver_capable: true,
            apply_fh: false,
            channel_bw_khz: Number(settings.enemy_bw_khz || 25),
            jammer_bw_khz: Number(settings.jammer_bw_khz || 20000)
        };
        return migrateV4ToV5({
            ...data,
            schema_version: 4,
            nodes: {
                ...data.nodes,
                red: (data.nodes?.red || []).map(node => ({ ...node, es_active: !!node.es_active, equipment: node.equipment || redEquipment })),
                blue: (data.nodes?.blue || []).map(node => ({ ...node, sensor_active: false, equipment: node.equipment || blueEquipment }))
            },
            profile_library: data.profile_library || { packs: [] }
        });
    }
    throw new Error(`Unsupported scenario schema v${data.schema_version}.`);
}

function setCounterFromIds(ids, prefix) {
    return ids.reduce((max, id) => {
        const match = String(id || '').match(new RegExp('^' + prefix + '(\\d+)$'));
        return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
}

function safeScenarioFilename(name) {
    const base = (name || '').trim()
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    if (base) return base + '.specter.json';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    return `specter-${stamp}.specter.json`;
}

function normalizeProfileId(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function assertFiniteRange(profile, field) {
    if (profile[field] == null || profile[field] === '') return;
    const value = Number(profile[field]);
    const range = PROFILE_NUMERIC_RANGES[field];
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
        throw new Error(`${profile.name || profile.id || 'Profile'} has invalid ${field}.`);
    }
    profile[field] = value;
}

function validateProfilePack(pack, options = {}) {
    if (!pack || typeof pack !== 'object') throw new Error('Profile pack is not valid JSON.');
    const schemaVersion = Number(pack.schema_version);
    if (![1, 2].includes(schemaVersion)) throw new Error('Equipment library schema_version must be 1 or 2.');
    if (!normalizeProfileId(pack.pack_id)) throw new Error('Profile pack is missing pack_id.');
    if (!String(pack.pack_name || '').trim()) throw new Error('Profile pack is missing pack_name.');
    const entries = Array.isArray(pack.templates) ? pack.templates : pack.profiles;
    if (!Array.isArray(entries)) throw new Error('Equipment library templates must be an array.');

    const seen = new Set();
    const normalizedTemplates = entries.map(raw => {
        if (!raw || typeof raw !== 'object') throw new Error('Template entries must be objects.');
        const profile = { ...raw };
        profile.id = normalizeProfileId(profile.id || profile.name);
        profile.name = String(profile.name || profile.id).trim().slice(0, 100);
        profile.equipment_type = String(profile.equipment_type || profile.category || 'radio').trim().toLowerCase();
        profile.category = profile.equipment_type;
        if (!profile.id || !profile.name) throw new Error('Every template needs an id and name.');
        if (!PROFILE_CATEGORIES.includes(profile.equipment_type)) throw new Error(`${profile.name} has unsupported equipment type.`);
        if (!options.allowJammerProfiles && profile.equipment_type === 'jammer') {
            throw new Error('Built-in packs cannot include jammer templates.');
        }
        if (seen.has(profile.id)) throw new Error(`Duplicate template id ${profile.id}.`);
        seen.add(profile.id);

        Object.keys(PROFILE_NUMERIC_RANGES).forEach(field => assertFiniteRange(profile, field));
        if (profile.antenna_type != null) {
            profile.antenna_type = String(profile.antenna_type).toLowerCase() === 'directional' ? 'directional' : 'omni';
        }
        profile.receiver_capable = !!profile.receiver_capable;
        const roles = Array.isArray(profile.role_compatibility) ? profile.role_compatibility : ['enemy', 'friendly'];
        profile.role_compatibility = roles
            .map(role => String(role).toLowerCase())
            .filter(role => role === 'enemy' || role === 'friendly');
        if (profile.role_compatibility.length === 0) profile.role_compatibility = ['enemy', 'friendly'];
        ['manufacturer', 'model', 'notes', 'source_url'].forEach(field => {
            if (profile[field] != null) profile[field] = String(profile[field]).trim().slice(0, field === 'notes' ? 500 : 240);
        });
        return profile;
    });
    return {
        schema_version: 2,
        pack_id: normalizeProfileId(pack.pack_id),
        pack_name: String(pack.pack_name).trim().slice(0, 100),
        templates: normalizedTemplates,
        profiles: normalizedTemplates
    };
}

// ── Dual-mode export ──────────────────────────────────────────────────────
// Browser: classic script, everything above is already a shared global.
// Node (tests/js/): no package.json, so this file loads as CommonJS.
const SpecterSchema = {
    SCENARIO_SCHEMA_VERSION, SPECTER_APP_VERSION,
    PROFILE_CATEGORIES, PROFILE_NUMERIC_RANGES,
    validateScenario, migrateScenario, validateProfilePack,
    normalizeProfileId, assertFiniteRange, scenarioNow,
    setCounterFromIds, safeScenarioFilename, latLngToPlain,
};
if (typeof window !== 'undefined') window.SpecterSchema = SpecterSchema;
if (typeof module !== 'undefined' && module.exports) module.exports = SpecterSchema;
