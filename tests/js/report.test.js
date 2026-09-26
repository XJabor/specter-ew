// Unit tests for the calculation result model (static/js/calc_results.js) and
// the report model (static/js/report_model.js).
// Run with: node --test "tests/js/*.test.js"   (Node 18+, no dependencies)
//
// Backend responses come from tests/fixtures/api_responses.json, which
// tests/test_api_fixtures.py keeps structurally identical to the live API.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const R = require('../../static/js/calc_results.js');
const P = require('../../static/js/report_model.js');
const schema = require('../../static/js/scenario_schema.js');
const API = require(path.join(__dirname, '..', 'fixtures', 'api_responses.json'));

const clone = v => JSON.parse(JSON.stringify(v));

function linkRecord(fixture = API.ea_terrain, id = 'B1-R2|R1-R2') {
    return R.buildLinkResult({
        id,
        subject: { jammer: { id: 'B1', name: 'Jammer One' }, transmitter: { id: 'R1', name: 'Enemy TX' }, target: { id: 'R2', name: 'Enemy RX' } },
        request: fixture.request,
        response: fixture.response,
        computedAt: '2026-09-26T12:00:00.000Z',
    });
}

function ringRecord(fixture = API.es_ring, kind = 'es-ring', id = 'es:R1') {
    return R.buildFootprintResult({
        kind, id,
        subject: { node: { id: 'R1', name: 'Enemy TX' }, sensor: { name: 'Generic Friendly Sensor' } },
        request: fixture.request,
        response: fixture.response,
        computedAt: '2026-09-26T12:00:00.000Z',
    });
}

function section(view, heading) {
    const s = view.sections.find(x => x.heading.startsWith(heading));
    assert.ok(s, `missing section ${heading}`);
    return Object.fromEntries(s.rows.map(r => [r.label, r.value]));
}

const codes = view => view.warnings.map(w => w.code);

// ── Result records & inspector view ───────────────────────────────────────

test('EA link record reconciles with the backend response', () => {
    const rec = linkRecord();
    const resp = API.ea_terrain.response;
    assert.equal(rec.margin, resp.margin);
    assert.equal(rec.classification, 'complete');
    const view = R.describeResult(rec);
    const result = section(view, 'Result');
    assert.equal(result['J/S margin (jamming − enemy)'], R.fmtSignedDb(resp.margin, 2));
    assert.equal(result['Jamming signal at target'], R.fmtDbm(resp.jammer_rx_signal));
    assert.equal(result['Enemy signal at target'], R.fmtDbm(resp.enemy_rx_signal));
    assert.equal(result.Assessment, resp.effect);
    assert.equal(view.headline.tone, 'good');
});

test('EA inspector explains every link budget term', () => {
    const view = R.describeResult(linkRecord());
    const d = API.ea_terrain.response.diagnostics;
    const jam = section(view, 'Jamming signal');
    assert.equal(jam['EIRP toward target'], R.fmtDbm(d.jammer.eirp_dbm));
    assert.equal(jam['EIRP before FH tax'], R.fmtDbm(d.jammer.eirp_before_fh_dbm));
    assert.match(jam['Frequency-hopping tax'], /^-10\.0 dB/);
    assert.match(jam['TX antenna gain toward target'], /off-boresight/);
    assert.equal(jam['Propagation model'], 'Egli (1957)');
    assert.equal(jam['Total path loss'], R.fmtDb(d.jammer.path_loss.loss_db));
    assert.equal(jam['Received at target'], R.fmtDbm(d.jammer.rx_dbm));
    const enemy = section(view, 'Enemy signal');
    assert.equal(enemy['Terrain profile'], 'Line of sight');
    assert.equal(enemy['Frequency-hopping tax'], undefined);
    assert.deepEqual(view.models.map(m => m.id), ['egli']);
});

test('EA warnings: remote elevation, and no-coordinate fallback', () => {
    const withTerrain = R.describeResult(linkRecord());
    assert.ok(codes(withTerrain).includes('remote-elevation'));
    const noCoords = R.describeResult(linkRecord(API.ea_no_coords));
    assert.ok(codes(noCoords).includes('no-coordinates'));
    assert.equal(section(noCoords, 'Enemy signal')['Terrain profile'], 'Not used (no terrain profile)');
});

test('EA warnings: terrain lookup failure and SHF blockage', () => {
    const fx = clone(API.ea_terrain);
    fx.response.terrain_warnings = ['Enemy-link terrain data unavailable; used non-terrain path loss.'];
    Object.assign(fx.response.diagnostics.jammer.path_loss, { model: 'shf', is_los: false, diffraction_db: 14.2 });
    const view = R.describeResult(linkRecord(fx));
    assert.ok(codes(view).includes('missing-terrain'));
    assert.ok(codes(view).includes('shf-blockage'));
    assert.equal(section(view, 'Jamming signal')['Terrain blockage penalty'], '+14.2 dB');
});

test('ring record: ranges, sampling, and model', () => {
    const rec = ringRecord();
    const d = API.es_ring.response.diagnostics;
    assert.equal(rec.rangeKm, API.es_ring.response.base_range_km);
    assert.equal(rec.vertexCount, d.num_bearings);
    const view = R.describeResult(rec);
    assert.equal(view.title, 'Generic Friendly Sensor detects Enemy TX');
    const range = section(view, 'Range');
    assert.equal(range.Median, R.fmtKm(d.ranges.median_km));
    assert.equal(range.Minimum, R.fmtKm(d.ranges.min_km));
    const sampling = section(view, 'Terrain sampling');
    assert.equal(sampling['Bearings × samples'], `${d.num_bearings} × ${d.num_samples}`);
    assert.match(sampling['Elevation source'], /^Mixed/);
    assert.deepEqual(view.models.map(m => m.id), Object.keys(d.models_used));
});

test('ring warnings: fallback circle, horizon cap, stale, legacy', () => {
    const fallback = ringRecord(API.footprint_fallback, 'jammer-footprint', 'fp:B1');
    assert.equal(fallback.polygonFallback, true);
    assert.equal(R.recordElevationSource(fallback), 'fallback');
    assert.ok(codes(R.describeResult(fallback)).includes('fallback-circle'));

    const fx = clone(API.shf_ring);
    Object.assign(fx.response.diagnostics.flat_los, { horizon_capped: true, uncapped_distance_km: 20 });
    const view = R.describeResult(ringRecord(fx, 'red-system', 'sys:R1_S1'),
        { stale: true, legacySchema: { from: 4, to: 5 } });
    ['horizon-capped', 'stale', 'legacy-schema'].forEach(c =>
        assert.ok(codes(view).includes(c), `missing ${c}`));
    assert.equal(view.warnings.find(w => w.code === 'stale').level, 'warn');
});

test('model validity notes for COST-231 below 1500 MHz and Egli above 900 MHz', () => {
    const fx = clone(API.ea_terrain);
    fx.response.diagnostics.freq_mhz = 950;
    const view = R.describeResult(linkRecord(fx));
    assert.ok(view.warnings.some(w => w.code === 'model-validity' && /40–900 MHz/.test(w.text)));
    fx.response.diagnostics.freq_mhz = 450;
    fx.response.diagnostics.enemy.path_loss.model = 'cost231_hata';
    const hata = R.describeResult(linkRecord(fx));
    assert.ok(hata.warnings.some(w => w.code === 'model-validity' && /1500–2000/.test(w.text)));
});

test('responses without diagnostics still describe', () => {
    const bare = { status: 'success', margin: -8, effect: 'No Effect', jammer_los: null, enemy_los: null, terrain_warnings: [] };
    const view = R.describeResult(R.buildLinkResult({ id: 'x', subject: {}, request: {}, response: bare }));
    assert.ok(codes(view).includes('no-diagnostics'));
    assert.equal(view.headline.tone, 'bad');
});

test('summarizeRanges', () => {
    assert.deepEqual(R.summarizeRanges([3, 1, 2, 10]), { min_km: 1, max_km: 10, mean_km: 4, median_km: 2.5 });
    assert.equal(R.summarizeRanges([]), null);
});

// ── Report ────────────────────────────────────────────────────────────────

function snapshot(extra = {}) {
    const eq = (type, f) => ({ equipment_type: type, frequency_mhz: f, tx_power_w: 5, antenna_gain_dbi: 0, rx_sensitivity_dbm: -100, antenna_height_m: 2 });
    return {
        appVersion: schema.SPECTER_APP_VERSION,
        generatedAt: '2026-09-26T14:05:00.000Z',
        title: 'Exercise Alpha',
        scenarioName: 'alpha-1',
        marking: 'For planning use',
        mode: 'EA',
        settings: {
            enemyTerrain: 'rural', jammerTerrain: 'rural', lowerThreshold: -6, upperThreshold: 6,
            sensorReference: { name: 'Generic Friendly Sensor', rxSensitivityDbm: -100, rxGainDbi: 0 },
            footprintRxSensitivity: -90, epTerrain: 'rural', epRxSensitivity: -90,
        },
        nodes: {
            red: [
                { id: 'R1', name: 'Enemy TX', lat: 35.0, lon: -117.0, mgrs: '11SNV0000073000', elevationM: 612, equipment: eq('radio', 60), antenna: { type: 'omni', height_m: 2 },
                  systems: [{ id: 'R1_S1', name: 'Wi-Fi', freqMhz: 5800, txPowerW: 1, txGainDbi: 0, antennaType: 'omni', antennaBeamwidth: 360, antennaHeightAgl: 2 },
                            { id: 'R1_S2', name: 'Unused', freqMhz: 433, txPowerW: 0.1, txGainDbi: 0, antennaType: 'omni', antennaBeamwidth: 360, antennaHeightAgl: 1 }] },
                { id: 'R2', name: 'Enemy RX', lat: 35.045, lon: -117.0, mgrs: '11SNV0000078000', equipment: eq('radio', 60), antenna: { type: 'omni', height_m: 2 }, systems: [] },
            ],
            blue: [{ id: 'B1', name: 'Jammer One', lat: 35.045, lon: -116.967, equipment: { ...eq('jammer', 60), jammer_bw_khz: 250 }, antenna: { type: 'directional', azimuth_deg: 250, beamwidth_deg: 60, height_m: 5 } },
                   { id: 'B2', name: 'Idle Jammer', lat: 35.1, lon: -116.9, equipment: eq('jammer', 60), antenna: { type: 'omni', height_m: 1 } }],
            black: [{ id: 'M1', name: 'Checkpoint', lat: 35.02, lon: -117.02 }],
            ep: [{ id: 'EP1', name: 'Our CP', lat: 34.98, lon: -117.03, ringsHidden: false,
                   systems: [{ id: 'EP1_S1', name: 'Radio net', freqMhz: 150, txPowerW: 5, txGainDbi: 0, antennaType: 'omni', antennaBeamwidth: 360, antennaHeightAgl: 2 }] }],
        },
        enemyLinks: [{ id: 'R1-R2', txId: 'R1', rxId: 'R2', distanceKm: 5.0 }],
        jammingLinks: [{ id: 'B1-R2', blueId: 'B1', rxId: 'R2', distanceKm: 3.0 },
                       { id: 'B2-R1', blueId: 'B2', rxId: 'R1', distanceKm: 11.2 }],
        results: [
            { record: linkRecord(), stale: false },
            { record: ringRecord(), stale: false },
            { record: R.buildFootprintResult({ kind: 'red-system', id: 'sys:R1_S1', subject: { node: { id: 'R1', name: 'Enemy TX' }, system: { id: 'R1_S1', name: 'Wi-Fi' }, sensor: { name: 'Generic Friendly Sensor' } }, request: API.shf_ring.request, response: API.shf_ring.response }), stale: true },
            { record: R.buildFootprintResult({ kind: 'ep-system', id: 'ep:EP1_S1', subject: { node: { id: 'EP1', name: 'Our CP' }, system: { id: 'EP1_S1', name: 'Radio net' } }, request: API.es_ring.request, response: API.es_ring.response }), stale: false },
            { record: R.buildFootprintResult({ kind: 'jammer-footprint', id: 'fp:B1', subject: { node: { id: 'B1', name: 'Jammer One' } }, request: API.footprint_fallback.request, response: API.footprint_fallback.response }), stale: false },
        ],
        shapes: [{ kind: 'ring', color: '#ff0033', points: API.es_ring.response.polygon_points },
                 { kind: 'ring', color: '#00bcd4', center: [35.045, -116.967], radiusKm: 2 }],
        overlap: { visible: false, selected: [] },
        ...extra,
    };
}

test('report includes every node and every calculated result', () => {
    const snap = snapshot();
    const report = P.buildReportData(snap);
    const html = P.renderReportHtml(report);
    const allNodes = Object.values(snap.nodes).flat();
    assert.equal(report.nodeRows.length, allNodes.length);
    allNodes.forEach(n => assert.ok(html.includes(n.name), `node ${n.name} missing`));

    snap.results.forEach(({ record }) => {
        assert.ok(report.details.find(d => d.id === record.id), `detail ${record.id} missing`);
        const inTable = record.kind === 'ea-link'
            ? report.linkRows.find(r => r.id === record.id)
            : report.ringRows.find(r => r.id === record.id);
        assert.ok(inTable, `table row ${record.id} missing`);
    });
    assert.equal(report.linkRows[0].margin, R.fmtSignedDb(API.ea_terrain.response.margin));
    assert.ok(html.includes(R.fmtSignedDb(API.ea_terrain.response.margin)));
    // Systems: one calculated, one listed as not calculated.
    assert.equal(report.enemySystemRows.length, 2);
    assert.equal(report.enemySystemRows.find(r => r.system === 'Unused').range, 'Not calculated');
    assert.equal(report.epRows.length, 1);
    assert.notEqual(report.epRows[0].range, 'Not calculated');
});

test('report metadata: version, timestamp, marking, disclaimer, footer', () => {
    const report = P.buildReportData(snapshot());
    const html = P.renderReportHtml(report);
    assert.equal(report.meta.appVersion, schema.SPECTER_APP_VERSION);
    assert.match(schema.SPECTER_APP_VERSION, /^\d+\.\d+\.\d+$/);
    assert.ok(html.includes(`Specter-EW <b>v${schema.SPECTER_APP_VERSION}</b>`));
    assert.ok(html.includes('2026-09-26 14:05:00 UTC'));
    assert.equal(html.split('For planning use').length - 1, 2, 'marking at top and bottom');
    assert.ok(html.includes('Planning estimates'));
    assert.ok(html.includes('GNU AGPL-3.0') && html.includes('contact@specter-ew.com'));
    ['Map', 'Node inventory', 'Jamming results (J/S)', 'ES rings &amp; jammer footprints', 'EP systems',
     'Settings', 'Propagation models used', 'Warnings', 'Calculation assumptions', 'Limitations', 'Calculation details']
        .forEach(h => assert.ok(html.includes(`<h2>${h}</h2>`), `section ${h} missing`));
});

test('report summarises models, terrain coverage, and warnings', () => {
    const report = P.buildReportData(snapshot({ legacySchema: { from: 4, to: 5 } }));
    const models = report.modelSummary.map(m => m.id).sort();
    assert.deepEqual(models, ['egli', 'shf']);
    assert.equal(report.coverage.fallback, 1);
    assert.equal(report.coverage.mixed, 4);
    const texts = report.warnings.map(w => w.text).join('\n');
    assert.match(texts, /schema v4/);
    assert.match(texts, /flat-terrain circle/);
    assert.match(texts, /1 jamming link\(s\) have no J\/S result/);
    assert.match(texts, /Inputs have changed/);
    // The migrated-schema note is reported once, not once per result.
    assert.equal(report.warnings.filter(w => /schema v4/.test(w.text)).length, 1);
});

test('report uses current node names, not names captured at calculation time', () => {
    const snap = snapshot();
    snap.nodes.blue[0].name = 'Renamed Jammer';
    const html = P.renderReportHtml(P.buildReportData(snap));
    assert.ok(html.includes('Renamed Jammer'));
    assert.ok(!html.includes('Jammer One'));
});

test('report never leaks secrets or environment details present in the snapshot', () => {
    const SECRETS = ['sk_live_SECRET', 'eyJhbGciOiJSUzI1NiJ9.SECRET', 'C:\\Users\\op\\secret_data', '/home/op/local_data', 'FLASK_SECRET_KEY=hunter2'];
    const snap = snapshot({
        cookie: `__session=${SECRETS[1]}`, clerkToken: SECRETS[0], dataDir: SECRETS[2], env: { FLASK_SECRET_KEY: SECRETS[4] },
    });
    snap.nodes.red[0].authToken = SECRETS[0];
    snap.nodes.red[0].equipment.notes = SECRETS[3];
    snap.nodes.red[0].equipment.source_url = SECRETS[2];
    snap.settings.dataDirPath = SECRETS[3];
    snap.results[0].record.request.api_key = SECRETS[0];
    snap.results[0].record.request.local_data_dir = SECRETS[2];
    const html = P.renderReportHtml(P.buildReportData(snap));
    SECRETS.forEach(s => assert.ok(!html.includes(s), `leaked ${s}`));
    assert.ok(!/__session|localStorage|document\.cookie/.test(html));
});

test('report escapes user-controlled text', () => {
    const snap = snapshot({ title: '<img src=x onerror=alert(1)>', marking: '"><script>alert(2)</script>' });
    snap.nodes.red[0].name = '<script>alert(3)</script>';
    const html = P.renderReportHtml(P.buildReportData(snap));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'));
});

test('map schematic: markers, shapes, links, scale bar', () => {
    const model = P.buildMapModel(snapshot());
    assert.equal(model.markers.length, 6);
    assert.equal(model.shapes.length, 2);
    assert.equal(model.lines.length, 3);
    assert.equal(model.lines.find(l => l.kind === 'jammer' && l.color === '#2e7d32') !== undefined, true);
    model.markers.forEach(m => {
        assert.ok(m.xy[0] >= 0 && m.xy[0] <= model.width && m.xy[1] >= 0 && m.xy[1] <= model.height);
    });
    assert.ok(model.scaleBar.px > 0 && model.scaleBar.px <= model.width / 4 + 1e-9);
    const mantissa = model.scaleBar.km / Math.pow(10, Math.floor(Math.log10(model.scaleBar.km)));
    assert.ok([1, 2, 5].some(m => Math.abs(mantissa - m) < 1e-9), `scale bar ${model.scaleBar.km} km is not 1/2/5×10^n`);
    const svg = P.renderMapSvg(model);
    assert.ok(svg.startsWith('<svg') && svg.includes('<polygon'));
    assert.equal(P.buildMapModel({ nodes: {} }), null);
});

test('map frames the nodes when one ring is far larger than the layout', () => {
    const huge = snapshot({ shapes: [{ kind: 'ring', color: '#3498db', center: [34.98, -117.03], radiusKm: 356 }] });
    const model = P.buildMapModel(huge);
    assert.equal(model.clipped, true);
    const xs = model.markers.map(m => m.xy[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) > model.width / 10, 'nodes should not collapse to a dot');
    assert.ok(P.renderReportHtml(P.buildReportData(huge)).includes('Some rings extend beyond the frame.'));
    assert.equal(P.buildMapModel(snapshot()).clipped, false);
});

test('map rejects non-hex colours from the snapshot', () => {
    const model = P.buildMapModel(snapshot({ shapes: [{ kind: 'ring', color: 'red" onload="alert(1)', center: [35, -117], radiusKm: 1 }] }));
    assert.equal(model.shapes[0].color, '#888888');
});
