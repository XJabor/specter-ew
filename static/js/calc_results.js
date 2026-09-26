// Specter-EW — calculation result model (pure logic, no DOM/Leaflet).
// Loaded right after scenario_schema.js; also loadable in Node for unit tests
// (see tests/js/). One record shape per calculation kind, plus
// describeResult(), the single place that turns a record into the titled
// sections and warning flags that BOTH the inspector panel and the report
// render — so the two can never disagree about how a result was produced.
(function () {
'use strict';

// Model ids come from core/propagation.py (MODEL_* constants); keep in sync.
const MODEL_INFO = {
    egli: {
        name: 'Egli (1957)',
        summary: 'Empirical VHF/UHF ground-wave model for low antennas over irregular terrain; loss grows 40 dB per decade of distance.',
        validity: 'Calibrated for 40–900 MHz with low antennas.',
    },
    two_ray: {
        name: 'Two-Ray Ground Reflection',
        summary: 'Direct plus ground-reflected ray, used for line-of-sight paths from an elevated (≥ 30 m) transmitter; 40 dB per decade beyond the breakpoint.',
        validity: 'Line-of-sight, ≥ 150 MHz, transmitter ≥ 30 m.',
    },
    cost231_hata: {
        name: 'COST-231 Hata',
        summary: 'Empirical macro-cell model for elevated transmitters on obstructed paths, with urban / suburban / open-area corrections.',
        validity: 'Published for 1500–2000 MHz, 30–200 m masts, 1–20 km; applied here from 150 MHz.',
    },
    upper_uhf: {
        name: 'Two-ray ground + clutter (1–2 GHz)',
        summary: 'Plane-earth two-ray loss (free-space inside the ground-reflection breakpoint, 40 dB per decade beyond it) plus a flat terrain/clutter correction, for 1–2 GHz with low antennas; range limited to the radio horizon.',
        validity: '1000–2000 MHz, transmitter below 30 m.',
    },
    free_space: {
        name: 'Free-space (Friis)',
        summary: 'Free-space path loss with no ground or clutter effects, for airborne or clear elevated paths.',
        validity: 'Terrain set to "Free space".',
    },
    shf: {
        name: 'SHF two-ray ground + foliage',
        summary: 'Plane-earth two-ray loss over ground (free-space loss for "Free space" terrain) plus distance-proportional foliage absorption and a near-ground canopy penalty; terrain obstruction is treated as blockage; range limited to the radio horizon.',
        validity: 'Above 2 GHz.',
    },
};

const TERRAIN_LABELS = {
    'free space':   'Free space (air)',
    'rural':        'Rural / open',
    'light forest': 'Light forest / suburban',
    'dense forest': 'Dense forest / urban',
};

const RESULT_KIND_LABELS = {
    'ea-link':          'Jamming link (J/S)',
    'es-ring':          'ES detection ring',
    'sensor-coverage':  'Sensor coverage ring',
    'red-system':       'Enemy system ring',
    'ep-system':        'EP system ring',
    'jammer-footprint': 'Jammer footprint',
};

const FOOTPRINT_KINDS = ['es-ring', 'sensor-coverage', 'red-system', 'ep-system', 'jammer-footprint'];

// ── Formatting ─────────────────────────────────────────────────────────────

function isNum(v) {
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function fmtNum(v, digits = 1) {
    return isNum(v) ? Number(v).toFixed(digits) : '—';
}

function fmtDb(v, digits = 1) { return isNum(v) ? `${fmtNum(v, digits)} dB` : '—'; }
function fmtDbm(v, digits = 1) { return isNum(v) ? `${fmtNum(v, digits)} dBm` : '—'; }
function fmtDbi(v, digits = 1) { return isNum(v) ? `${fmtNum(v, digits)} dBi` : '—'; }
function fmtKm(v, digits = 2) { return isNum(v) ? `${fmtNum(v, digits)} km` : '—'; }
function fmtMhz(v) { return isNum(v) ? `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 })} MHz` : '—'; }
function fmtSignedDb(v, digits = 1) {
    if (!isNum(v)) return '—';
    const n = Number(v);
    return `${n >= 0 ? '+' : ''}${n.toFixed(digits)} dB`;
}

function fmtWatts(v) {
    if (!isNum(v)) return '—';
    const w = Number(v);
    if (w >= 1) return `${Number(w.toPrecision(4))} W`;
    return `${Number((w * 1000).toPrecision(4))} mW`;
}

function terrainLabel(t) {
    return TERRAIN_LABELS[t] || (t ? String(t) : '—');
}

function modelName(id) {
    return MODEL_INFO[id]?.name || (id ? String(id) : '—');
}

function gainText(peak, effective) {
    if (!isNum(effective)) return fmtDbi(peak);
    if (isNum(peak) && Math.abs(Number(peak) - Number(effective)) >= 0.05) {
        return `${fmtDbi(effective)} (peak ${fmtDbi(peak)}, off-boresight)`;
    }
    return fmtDbi(effective);
}

function antennaText(a) {
    if (!a) return '—';
    const height = isNum(a.height_m) ? `, ${fmtNum(Math.max(1, Number(a.height_m)), 1)} m AGL` : '';
    if (a.type === 'directional') {
        return `Directional, az ${fmtNum(a.azimuth_deg, 0)}°, ${fmtNum(a.beamwidth_deg, 0)}° beamwidth${height}`;
    }
    return `Omni${height}`;
}

// ── Record builders ────────────────────────────────────────────────────────

function jsClassification(margin, lower, upper) {
    if (!isNum(margin)) return 'unknown';
    if (Number(margin) >= Number(upper)) return 'complete';
    if (Number(margin) <= Number(lower)) return 'none';
    return 'contested';
}

// EA jamming pair: one blue jammer, one enemy comms link (TX → target RX).
// `subject` holds {id, name} for jammer / transmitter / target.
function buildLinkResult({ id, subject, request, response, computedAt }) {
    const diag = response?.diagnostics || null;
    const thresholds = diag?.thresholds_db || {
        no_effect_at_or_below: Number(request?.lower_threshold ?? -6),
        complete_at_or_above: Number(request?.upper_threshold ?? 6),
    };
    return {
        kind: 'ea-link',
        id,
        computedAt: computedAt || new Date().toISOString(),
        subject,
        request: request || {},
        margin: response?.margin ?? null,
        effect: response?.effect ?? null,
        classification: jsClassification(response?.margin,
            thresholds.no_effect_at_or_below, thresholds.complete_at_or_above),
        thresholds,
        enemyLos: response?.enemy_los ?? null,
        jammerLos: response?.jammer_los ?? null,
        terrainWarnings: Array.isArray(response?.terrain_warnings) ? response.terrain_warnings.slice() : [],
        diagnostics: diag,
    };
}

function summarizeRanges(values) {
    const xs = (values || []).filter(isNum).map(Number).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const mid = Math.floor(xs.length / 2);
    const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const r3 = x => Math.round(x * 1000) / 1000;
    return { min_km: r3(xs[0]), max_km: r3(xs[xs.length - 1]), mean_km: r3(mean), median_km: r3(median) };
}

// Terrain-shaped ring / footprint.  `subject` holds {node, system?, sensor?}
// (each {id, name}); `threshold` describes the receiver the ring is drawn for.
function buildFootprintResult({ kind, id, subject, request, response, computedAt }) {
    const diag = response?.diagnostics || null;
    const polygon = Array.isArray(response?.polygon_points) ? response.polygon_points : null;
    return {
        kind,
        id,
        computedAt: computedAt || new Date().toISOString(),
        subject,
        request: request || {},
        rangeKm: response?.base_range_km ?? null,
        polygonFallback: !polygon,
        vertexCount: polygon ? polygon.length : 0,
        ranges: diag?.ranges || (isNum(response?.base_range_km) ? summarizeRanges([response.base_range_km]) : null),
        diagnostics: diag,
    };
}

// ── Warnings ───────────────────────────────────────────────────────────────

function warning(code, level, text) {
    return { code, level, text };
}

function elevationWarnings(elev, where) {
    const out = [];
    if (!elev) return out;
    const prefix = where ? `${where}: ` : '';
    if (elev.source === 'remote' || elev.source === 'mixed') {
        const share = elev.source === 'mixed'
            ? `${elev.remote_samples} of ${elev.remote_samples + elev.local_samples} samples`
            : 'all samples';
        out.push(warning('remote-elevation', 'info',
            `${prefix}Terrain heights from the online SRTM 30 m service (${share}); local DTED did not cover the path.`));
    }
    if (isNum(elev.void_samples) && elev.void_samples > 0) {
        out.push(warning('terrain-voids', 'warn',
            `${prefix}${elev.void_samples} terrain sample(s) were data voids and treated as 0 m elevation.`));
    }
    return out;
}

function validityWarnings(modelId, freqMhz) {
    const f = Number(freqMhz);
    if (modelId === 'egli' && isNum(f) && (f < 40 || f > 900)) {
        return [warning('model-validity', 'info',
            `Egli is calibrated for 40–900 MHz; ${fmtMhz(f)} is outside that range.`)];
    }
    if (modelId === 'cost231_hata' && isNum(f) && f < 1500) {
        return [warning('model-validity', 'info',
            `COST-231 Hata is published for 1500–2000 MHz; it is applied here at ${fmtMhz(f)} as the elevated-transmitter NLOS model.`)];
    }
    return [];
}

function contextWarnings(ctx) {
    const out = [];
    if (ctx?.stale) {
        out.push(warning('stale', 'warn',
            'Inputs have changed since this result was calculated. Recalculate before relying on it.'));
    }
    if (ctx?.legacySchema) {
        out.push(warning('legacy-schema', 'info',
            `Scenario was loaded from an older file format (schema v${ctx.legacySchema.from}, now v${ctx.legacySchema.to}) and migrated; results were recalculated with the current model.`));
    }
    return out;
}

function dedupeWarnings(list) {
    const seen = new Set();
    return list.filter(w => {
        const key = `${w.code}|${w.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function linkWarnings(record, ctx) {
    const d = record.diagnostics;
    const out = contextWarnings(ctx);
    if (!d) {
        out.push(warning('no-diagnostics', 'info', 'The server did not return calculation diagnostics for this result.'));
        return out;
    }
    record.terrainWarnings.forEach(t => out.push(warning('missing-terrain', 'warn', t)));
    if (!d.bearing_gains_applied) {
        out.push(warning('no-coordinates', 'info',
            'Node coordinates were not available, so directional antenna patterns were not applied (peak gains used).'));
    }
    [['Enemy path', d.enemy], ['Jammer path', d.jammer]].forEach(([label, p]) => {
        if (!p) return;
        out.push(...elevationWarnings(p.elevation, label));
        const pl = p.path_loss || {};
        if (pl.model === 'shf' && !pl.is_los && Number(pl.diffraction_db) > 0) {
            out.push(warning('shf-blockage', 'info',
                `${label}: SHF terrain-blockage penalty of ${fmtDb(pl.diffraction_db)} applied (at SHF the diffraction value stands in for opaque blockage).`));
        }
        if (pl.fspl_floor_applied) {
            out.push(warning('fspl-floor', 'info',
                `${label}: the empirical model fell below free-space loss, so free-space loss was used as a floor.`));
        }
        out.push(...validityWarnings(pl.model, d.freq_mhz).map(w => ({ ...w, text: `${label}: ${w.text}` })));
        if (isNum(p.distance_km) && Number(p.distance_km) > 50) {
            out.push(warning('long-path', 'warn', `${label} is ${fmtKm(p.distance_km, 1)}; results beyond 50 km are less reliable.`));
        }
    });
    return dedupeWarnings(out);
}

function footprintWarnings(record, ctx) {
    const d = record.diagnostics;
    const out = contextWarnings(ctx);
    if (record.polygonFallback) {
        out.push(warning('fallback-circle', 'warn',
            'Terrain data was unavailable, so this ring is a flat-terrain circle rather than a terrain-shaped polygon.'));
    }
    if (!d) {
        out.push(warning('no-diagnostics', 'info', 'The server did not return calculation diagnostics for this result.'));
        return dedupeWarnings(out);
    }
    out.push(...elevationWarnings(d.elevation));
    const cap = [d.flat_los, d.flat_nlos].find(s => s?.horizon_capped);
    if (cap) {
        out.push(warning('horizon-capped', 'info',
            `Range limited by the 4/3-earth radio horizon (${fmtKm(cap.horizon_km, 1)}); the model alone would reach ${fmtKm(cap.uncapped_distance_km, 1)}.`));
    }
    if ([d.flat_los, d.flat_nlos].some(s => s?.fspl_floor_limited)) {
        out.push(warning('fspl-floor', 'info',
            'Range set by the free-space floor rather than the empirical model (short range / tall mast).'));
    }
    if ((d.models_used || {}).shf && d.blocked_bearings > 0) {
        out.push(warning('shf-blockage', 'info',
            `SHF terrain-blockage penalty applied on ${d.blocked_bearings} of ${d.num_bearings} bearings.`));
    }
    const models = Object.keys(d.models_used || {});
    (models.length ? models : [d.flat_los?.model]).forEach(m => out.push(...validityWarnings(m, d.freq_mhz)));
    return dedupeWarnings(out);
}

// ── describeResult ─────────────────────────────────────────────────────────
// Returns { title, subtitle, kindLabel, headline:{label,value,tone},
//           models:[{id,name,summary,validity}], sections:[{heading, rows:[{label,value,sub}]}],
//           warnings:[{code,level,text}] }.
// ctx: { stale?: bool, legacySchema?: {from,to} }

function row(label, value, sub = false) {
    return { label, value: value == null || value === '' ? '—' : String(value), sub };
}

function losText(los, used) {
    if (!used) return 'Not used (no terrain profile)';
    if (!los) return 'Unavailable';
    if (los.is_los) return 'Line of sight';
    return `Obstructed — ${fmtNum(los.max_obstruction_m, 1)} m above the path at ${fmtKm(los.obstruction_distance_km, 2)}`;
}

function pathLossRows(pl) {
    const rows = [
        row('Propagation model', modelName(pl.model)),
        row('Free-space loss (reference)', fmtDb(pl.fspl_db)),
        row('Model path loss', fmtDb(pl.base_loss_db) + (pl.fspl_floor_applied ? ' (free-space floor)' : '')),
    ];
    if (Number(pl.terrain_correction_db)) rows.push(row('incl. terrain/clutter correction', fmtSignedDb(pl.terrain_correction_db), true));
    if (Number(pl.clutter_db)) rows.push(row('incl. foliage absorption', fmtSignedDb(pl.clutter_db), true));
    if (Number(pl.near_ground_penalty_db)) rows.push(row('incl. near-ground canopy penalty', fmtSignedDb(pl.near_ground_penalty_db), true));
    if (!pl.is_los || Number(pl.diffraction_db)) {
        rows.push(row(pl.model === 'shf' ? 'Terrain blockage penalty' : 'Diffraction loss', fmtSignedDb(pl.diffraction_db)));
    }
    rows.push(row('Total path loss', fmtDb(pl.loss_db)));
    return rows;
}

function eaPathSection(heading, p, txW, extraRows = []) {
    if (!p) return { heading, rows: [row('Details', 'Unavailable')] };
    const pl = p.path_loss || {};
    return {
        heading,
        rows: [
            row('Distance', fmtKm(p.distance_km)),
            row('Terrain setting', terrainLabel(p.terrain)),
            row('Antenna heights', `TX ${fmtNum(Math.max(1, Number(p.tx_height_m) || 1), 1)} m / RX ${fmtNum(Math.max(1, Number(p.rx_height_m) || 1), 1)} m AGL`),
            row('Terrain profile', losText(p.los, p.terrain_profile_used)),
            row('TX power', `${fmtWatts(txW)} (${fmtDbm(p.tx_power_dbm)})`),
            row('TX antenna gain toward target', gainText(p.tx_gain_peak_dbi, p.tx_gain_effective_dbi)),
            ...extraRows,
            row('EIRP toward target', fmtDbm(p.eirp_dbm)),
            ...pathLossRows(pl),
            row('Target RX antenna gain', gainText(p.rx_gain_peak_dbi, p.rx_gain_effective_dbi)),
            row('Received at target', fmtDbm(p.rx_dbm)),
        ],
    };
}

const CLASSIFICATION_TONE = { complete: 'good', contested: 'mixed', none: 'bad', unknown: 'neutral' };

function describeLink(record, ctx) {
    const d = record.diagnostics;
    const s = record.subject || {};
    const req = record.request || {};
    const models = [];
    [d?.enemy?.path_loss?.model, d?.jammer?.path_loss?.model].forEach(m => {
        if (m && !models.find(x => x.id === m)) models.push({ id: m, ...(MODEL_INFO[m] || { name: m }) });
    });
    const sections = [{
        heading: 'Link',
        rows: [
            row('Jammer', s.jammer?.name),
            row('Target receiver', s.target?.name),
            row('Enemy transmitter', s.transmitter?.name),
            row('Frequency', fmtMhz(d?.freq_mhz ?? req.freq_mhz)),
            row('Directional patterns applied', d ? (d.bearing_gains_applied ? 'Yes (by bearing)' : 'No (no coordinates)') : '—'),
        ],
    }];
    if (d) {
        // The inspector reads LOS details off the path; attach the response LOS objects.
        const enemy = d.enemy && { ...d.enemy, los: record.enemyLos };
        const jammer = d.jammer && { ...d.jammer, los: record.jammerLos };
        sections.push(eaPathSection('Enemy signal (transmitter → target)', enemy, req.enemy_tx_w));
        const fh = d.jammer?.fh || {};
        const fhRows = fh.applied
            ? [row('EIRP before FH tax', fmtDbm(d.jammer.eirp_before_fh_dbm)),
               row('Frequency-hopping tax', `${fmtSignedDb(-fh.tax_db)} (${fmtNum(fh.jammer_bw_khz, 0)} kHz sweep ÷ ${fmtNum(fh.enemy_bw_khz, 1)} kHz channel)`)]
            : [row('Frequency-hopping tax', 'Not applied')];
        sections.push(eaPathSection('Jamming signal (jammer → target)', jammer, req.jammer_tx_w, fhRows));
    }
    sections.push({
        heading: 'Result',
        rows: [
            row('Jamming signal at target', fmtDbm(d?.jammer?.rx_dbm)),
            row('Enemy signal at target', fmtDbm(d?.enemy?.rx_dbm)),
            row('J/S margin (jamming − enemy)', fmtSignedDb(record.margin, 2)),
            row('Thresholds', `No effect ≤ ${fmtSignedDb(record.thresholds.no_effect_at_or_below)} · Complete ≥ ${fmtSignedDb(record.thresholds.complete_at_or_above)}`),
            row('Assessment', record.effect),
        ],
    });
    return {
        title: `${s.jammer?.name || '?'} → ${s.target?.name || '?'}`,
        subtitle: `Jamming ${s.transmitter?.name || '?'} → ${s.target?.name || '?'} comms`,
        kindLabel: RESULT_KIND_LABELS['ea-link'],
        headline: {
            label: 'J/S margin',
            value: isNum(record.margin) ? `${fmtSignedDb(record.margin, 1)} — ${record.effect}` : 'Not calculated',
            tone: CLASSIFICATION_TONE[record.classification] || 'neutral',
        },
        models,
        sections,
        warnings: linkWarnings(record, ctx),
    };
}

function footprintTitle(record) {
    const s = record.subject || {};
    switch (record.kind) {
        case 'es-ring':
        case 'sensor-coverage':
            return `${s.sensor?.name || 'Sensor'} detects ${s.node?.name || '?'}`;
        case 'red-system':
            return `${s.node?.name || '?'} — ${s.system?.name || 'System'}`;
        case 'ep-system':
            return `${s.node?.name || '?'} — ${s.system?.name || 'System'}`;
        case 'jammer-footprint':
            return `${s.node?.name || '?'} jammer footprint`;
        default:
            return s.node?.name || record.id;
    }
}

function thresholdDescription(record) {
    switch (record.kind) {
        case 'jammer-footprint':
            return 'Reference receiver threshold (sidebar)';
        case 'ep-system':
            return 'Enemy receiver sensitivity (EP settings)';
        default:
            return `${record.subject?.sensor?.name || 'Sensor'} sensitivity`;
    }
}

function receiverHeightText(d, req) {
    // Diagnostics carry the height as the models applied it (floored at 1 m);
    // responses from before v1.2.0's receiver-height support imply ground level.
    const applied = isNum(d?.rx_height_m) ? Number(d.rx_height_m)
        : Math.max(1, Number(req?.rx_antenna_height_m) || 0);
    return `${fmtNum(applied, 1)} m AGL`;
}

function describeFootprint(record, ctx) {
    const d = record.diagnostics;
    const req = record.request || {};
    const s = record.subject || {};
    const txW = req.enemy_tx_w ?? req.jammer_tx_w;
    const txGain = req.enemy_tx_gain ?? req.jammer_tx_gain;
    const modelIds = d ? Object.keys(d.models_used || {}) : [];
    if (d && modelIds.length === 0 && d.flat_los?.model) modelIds.push(d.flat_los.model);
    const models = modelIds.map(m => ({ id: m, ...(MODEL_INFO[m] || { name: m }) }));

    const sections = [{
        heading: 'Emitter',
        rows: [
            row(record.kind === 'jammer-footprint' ? 'Jammer' : 'Transmitter',
                s.system ? `${s.node?.name || '?'} / ${s.system.name}` : s.node?.name),
            row('Frequency', fmtMhz(d?.freq_mhz ?? req.freq_mhz)),
            row('TX power', d ? `${fmtWatts(txW)} (${fmtDbm(d.tx_power_dbm)})` : fmtWatts(txW)),
            row('TX antenna gain', fmtDbi(txGain)),
            row('Antenna', antennaText(d?.antenna || {
                type: req.tx_antenna_type ?? req.jammer_antenna_type,
                azimuth_deg: req.tx_azimuth_deg ?? req.jammer_azimuth_deg,
                beamwidth_deg: req.tx_beamwidth_deg ?? req.jammer_beamwidth_deg,
                height_m: req.tx_antenna_height_m ?? req.jammer_antenna_height_m,
            })),
            row('Peak EIRP', fmtDbm(d?.peak_eirp_dbm)),
        ],
    }, {
        heading: 'Receiver reference',
        rows: [
            row(thresholdDescription(record), fmtDbm(d?.rx_sensitivity_dbm ?? req.rx_sensitivity)),
            row('Receiver antenna gain', fmtDbi(d?.rx_gain_dbi ?? req.friendly_rx_gain)),
            row('Receiver antenna height', receiverHeightText(d, req)),
            row('Link budget (max path loss)', fmtDb(d?.flat_los?.budget_db)),
        ],
    }];

    if (d) {
        sections.push({
            heading: 'Model',
            rows: [
                row('Terrain setting', terrainLabel(d.terrain)),
                row('Flat-terrain LOS range', `${fmtKm(d.flat_los?.distance_km)} (${modelName(d.flat_los?.model)})`),
                row('Flat-terrain NLOS range', `${fmtKm(d.flat_nlos?.distance_km)} (${modelName(d.flat_nlos?.model)})`),
                row('Models used along bearings', modelIds.length
                    ? modelIds.map(m => `${modelName(m)} × ${d.models_used[m] ?? '—'}`).join(', ')
                    : 'n/a (flat-terrain circle)'),
            ],
        }, {
            heading: 'Terrain sampling',
            rows: [
                row('Bearings × samples', `${d.num_bearings} × ${d.num_samples}`),
                row('Resolution', d.locally_covered
                    ? 'High (all DTED cells local)' : 'Standard (online elevation, rate-limited)'),
                row('Elevation source', elevationSourceText(d.elevation)),
                row('Bearings obstructed by terrain', record.polygonFallback ? '—' : `${d.blocked_bearings} of ${d.num_bearings}`),
                row('Bearings at the flat-terrain limit', record.polygonFallback ? '—' : `${d.bearings_at_projection_limit} of ${d.num_bearings}`),
                row('Profile length', fmtKm(d.projection_range_km, 2)),
            ],
        });
    }
    const r = record.ranges;
    sections.push({
        heading: 'Range',
        rows: [
            row('Minimum', fmtKm(r?.min_km)),
            row('Median', fmtKm(r?.median_km)),
            row('Mean', fmtKm(r?.mean_km)),
            row('Maximum', fmtKm(r?.max_km)),
            row('Map label value', `${fmtKm(record.rangeKm, 1)} (flat-terrain LOS range)`),
            row('Polygon', record.polygonFallback
                ? 'Circle (terrain unavailable)' : `${record.vertexCount} vertices, one per bearing`),
        ],
    });

    return {
        title: footprintTitle(record),
        subtitle: RESULT_KIND_LABELS[record.kind],
        kindLabel: RESULT_KIND_LABELS[record.kind],
        headline: {
            label: 'Range',
            value: r ? `${fmtKm(r.median_km, 1)} median (${fmtNum(r.min_km, 1)}–${fmtNum(r.max_km, 1)} km)` : 'Not calculated',
            tone: 'neutral',
        },
        models,
        sections,
        warnings: footprintWarnings(record, ctx),
    };
}

function elevationSourceText(elev) {
    if (!elev) return '—';
    switch (elev.source) {
        case 'local':   return `Local DTED (${elev.local_samples} samples)`;
        case 'remote':  return `Online SRTM 30 m (${elev.remote_samples} samples)`;
        case 'mixed':   return `Mixed: ${elev.local_samples} local DTED, ${elev.remote_samples} online SRTM`;
        case 'none':    return 'Not used';
        default:        return 'Not recorded';
    }
}

function describeResult(record, ctx = {}) {
    if (!record) return null;
    if (record.kind === 'ea-link') return describeLink(record, ctx);
    if (FOOTPRINT_KINDS.includes(record.kind)) return describeFootprint(record, ctx);
    throw new Error(`Unknown result kind: ${record.kind}`);
}

// Where terrain heights came from for a record, as one keyword:
// 'local' | 'remote' | 'mixed' | 'fallback' | 'none' | 'unknown'.
function recordElevationSource(record) {
    if (!record) return 'unknown';
    if (record.kind === 'ea-link') {
        const d = record.diagnostics;
        if (!d) return 'unknown';
        const sources = [d.enemy?.elevation?.source, d.jammer?.elevation?.source].filter(Boolean);
        if (sources.length === 0) return 'none';
        if (record.terrainWarnings.length) return 'fallback';
        const set = new Set(sources.filter(s => s !== 'none'));
        if (set.size === 0) return 'none';
        if (set.size > 1 || set.has('mixed')) return 'mixed';
        return [...set][0];
    }
    if (record.polygonFallback) return 'fallback';
    return record.diagnostics?.elevation?.source || 'unknown';
}

// Model ids a record relied on, with how many paths/bearings used each.
function recordModelUsage(record) {
    const usage = {};
    if (!record?.diagnostics) return usage;
    if (record.kind === 'ea-link') {
        [record.diagnostics.enemy, record.diagnostics.jammer].forEach(p => {
            const m = p?.path_loss?.model;
            if (m) usage[m] = (usage[m] || 0) + 1;
        });
        return usage;
    }
    const used = record.diagnostics.models_used || {};
    if (Object.keys(used).length === 0 && record.diagnostics.flat_los?.model) {
        usage[record.diagnostics.flat_los.model] = 1;
    }
    Object.entries(used).forEach(([m, n]) => { usage[m] = n; });
    return usage;
}

// ── Dual-mode export ──────────────────────────────────────────────────────
const SpecterResults = {
    MODEL_INFO, TERRAIN_LABELS, RESULT_KIND_LABELS, FOOTPRINT_KINDS,
    buildLinkResult, buildFootprintResult, summarizeRanges, describeResult,
    recordElevationSource, recordModelUsage, jsClassification,
    fmtNum, fmtDb, fmtDbm, fmtDbi, fmtKm, fmtMhz, fmtSignedDb, fmtWatts,
    terrainLabel, modelName, antennaText, elevationSourceText,
};
if (typeof window !== 'undefined') window.SpecterResults = SpecterResults;
if (typeof module !== 'undefined' && module.exports) module.exports = SpecterResults;
})();
