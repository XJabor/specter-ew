// Unit tests for the pure scenario-schema logic in static/js/scenario_schema.js.
// Run with: node --test "tests/js/*.test.js"   (Node 18+, no dependencies)
// The Python suite ignores this directory (unittest discovers test*.py only).
const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../../static/js/scenario_schema.js');

function minimalScenario(version, extra = {}) {
    return {
        schema_version: version,
        nodes: { red: [], blue: [], black: [], ep: [] },
        links: { enemy: [], jamming: [] },
        ...extra,
    };
}

function validPack(overrides = {}) {
    return {
        schema_version: 2,
        pack_id: 'test-pack',
        pack_name: 'Test Pack',
        templates: [
            { id: 'radio-1', name: 'Test Radio', equipment_type: 'radio', frequency_mhz: 146 },
        ],
        ...overrides,
    };
}

// ── validateScenario ────────────────────────────────────────────────────────

test('current-version scenario validates', () => {
    assert.equal(schema.validateScenario(minimalScenario(5)), true);
});

test('newer schema version is rejected', () => {
    assert.throws(() => schema.validateScenario(minimalScenario(6)),
        /newer than this app supports/);
});

test('missing schema_version, nodes, or links are rejected', () => {
    assert.throws(() => schema.validateScenario({ nodes: {}, links: {} }),
        /missing schema_version/);
    assert.throws(() => schema.validateScenario({ schema_version: 5, links: {} }),
        /missing nodes/);
    assert.throws(() => schema.validateScenario({ schema_version: 5, nodes: {} }),
        /missing links/);
});

test('out-of-range node location is rejected', () => {
    const s = minimalScenario(5);
    s.nodes.red = [{ id: 'R1', location: { lat: 95, lon: 0 } }];
    assert.throws(() => schema.validateScenario(s), /invalid location/);
});

test('node missing id or location is rejected', () => {
    const s = minimalScenario(5);
    s.nodes.blue = [{ location: { lat: 10, lon: 10 } }];
    assert.throws(() => schema.validateScenario(s), /missing id or location/);
});

test('embedded profile_library packs are validated (jammers allowed)', () => {
    const s = minimalScenario(5, {
        profile_library: {
            packs: [validPack({
                templates: [{ id: 'j1', name: 'Jammer', equipment_type: 'jammer' }],
            })],
        },
    });
    assert.equal(schema.validateScenario(s), true);
});

// ── migrateScenario ─────────────────────────────────────────────────────────

test('current-version scenario passes through unchanged', () => {
    const s = minimalScenario(5);
    assert.equal(schema.migrateScenario(s), s);
});

test('v4 scenario gains an empty red systems array', () => {
    const s = minimalScenario(4);
    s.nodes.red = [{ id: 'R1', location: { lat: 30, lon: -86 } }];
    const out = schema.migrateScenario(s);
    assert.equal(out.schema_version, 5);
    assert.deepEqual(out.nodes.red[0].systems, []);
});

test('existing red systems survive migration untouched', () => {
    const s = minimalScenario(4);
    const systems = [{ id: 'R1_S1', name: 'VHF Net', freq_mhz: 62.5 }];
    s.nodes.red = [{ id: 'R1', location: { lat: 30, lon: -86 }, systems }];
    const out = schema.migrateScenario(s);
    assert.equal(out.nodes.red[0].systems, systems);
});

test('v3 scenario gains booleanized ring flags and a profile_library', () => {
    const s = minimalScenario(3);
    s.nodes.red = [{ id: 'R1', location: { lat: 30, lon: -86 }, es_active: 1 }];
    s.nodes.blue = [{ id: 'B1', location: { lat: 30, lon: -86 } }];
    const out = schema.migrateScenario(s);
    assert.equal(out.schema_version, 5);
    assert.equal(out.nodes.red[0].es_active, true);
    assert.equal(out.nodes.blue[0].sensor_active, false);
    assert.deepEqual(out.profile_library, { packs: [] });
    // Guards the fall-through: older branches must not skip the v4 -> v5 step.
    assert.deepEqual(out.nodes.red[0].systems, []);
});

test('v1 scenario synthesizes node equipment from workspace settings', () => {
    const s = minimalScenario(1, {
        settings: { freq_mhz: 80, enemy_tx_w: 50, jammer_tx_w: 100, fh_toggle: true },
    });
    s.nodes.red = [{ id: 'R1', location: { lat: 30.4, lon: -86.5 } }];
    s.nodes.blue = [{ id: 'B1', location: { lat: 30.5, lon: -86.4 } }];
    const out = schema.migrateScenario(s);
    assert.equal(out.schema_version, 5);
    assert.deepEqual(out.nodes.red[0].systems, []);
    const red = out.nodes.red[0].equipment;
    assert.equal(red.equipment_type, 'radio');
    assert.equal(red.frequency_mhz, 80);
    assert.equal(red.tx_power_w, 50);
    assert.equal(red.apply_fh, true);
    const blue = out.nodes.blue[0].equipment;
    assert.equal(blue.equipment_type, 'jammer');
    assert.equal(blue.tx_power_w, 100);
    assert.equal(blue.receiver_capable, true);
    assert.deepEqual(out.profile_library, { packs: [] });
});

test('v1 node with existing equipment keeps it', () => {
    const s = minimalScenario(1);
    const equipment = { equipment_type: 'radio', frequency_mhz: 433 };
    s.nodes.red = [{ id: 'R1', location: { lat: 0, lon: 0 }, equipment }];
    const out = schema.migrateScenario(s);
    assert.equal(out.nodes.red[0].equipment, equipment);
});

test('unsupported old version is rejected', () => {
    assert.throws(() => schema.migrateScenario(minimalScenario(0)),
        /Unsupported scenario schema/);
});

// ── validateProfilePack ─────────────────────────────────────────────────────

test('valid pack normalizes to schema v2 with mirrored templates/profiles', () => {
    const out = schema.validateProfilePack(validPack({ schema_version: 1 }));
    assert.equal(out.schema_version, 2);
    assert.equal(out.pack_id, 'test-pack');
    assert.equal(out.templates.length, 1);
    assert.equal(out.profiles, out.templates);
    assert.deepEqual(out.templates[0].role_compatibility, ['enemy', 'friendly']);
});

test('jammer templates are rejected unless explicitly allowed', () => {
    const pack = validPack({
        templates: [{ id: 'j1', name: 'Jammer', equipment_type: 'jammer' }],
    });
    assert.throws(() => schema.validateProfilePack(pack),
        /cannot include jammer templates/);
    assert.equal(
        schema.validateProfilePack(pack, { allowJammerProfiles: true }).templates.length, 1);
});

test('duplicate template ids are rejected', () => {
    const pack = validPack({
        templates: [
            { id: 'radio-1', name: 'A', equipment_type: 'radio' },
            { id: 'radio-1', name: 'B', equipment_type: 'radio' },
        ],
    });
    assert.throws(() => schema.validateProfilePack(pack), /Duplicate template id/);
});

test('numeric fields outside their range are rejected', () => {
    const pack = validPack({
        templates: [{ id: 'r1', name: 'R', equipment_type: 'radio', frequency_mhz: 50000 }],
    });
    assert.throws(() => schema.validateProfilePack(pack), /invalid frequency_mhz/);
});

test('unknown equipment type is rejected', () => {
    const pack = validPack({
        templates: [{ id: 'x1', name: 'X', equipment_type: 'laser' }],
    });
    assert.throws(() => schema.validateProfilePack(pack), /unsupported equipment type/);
});

// ── small helpers ───────────────────────────────────────────────────────────

test('safeScenarioFilename sanitizes and falls back to a timestamp', () => {
    assert.equal(schema.safeScenarioFilename('My Op / Alpha'), 'My-Op-Alpha.specter.json');
    assert.match(schema.safeScenarioFilename(''), /^specter-.+\.specter\.json$/);
});

test('setCounterFromIds returns the max numeric suffix for the prefix', () => {
    assert.equal(schema.setCounterFromIds(['R1', 'R7', 'B3', null, 'R2x'], 'R'), 7);
    assert.equal(schema.setCounterFromIds([], 'R'), 0);
});

test('normalizeProfileId lowercases and strips unsafe characters', () => {
    assert.equal(schema.normalizeProfileId('  My Pack #1!  '), 'my-pack-1');
});

test('latLngToPlain maps Leaflet lng to scenario lon', () => {
    assert.deepEqual(schema.latLngToPlain({ lat: 1.5, lng: -2.5 }), { lat: 1.5, lon: -2.5 });
});
