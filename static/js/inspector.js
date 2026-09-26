// Specter-EW — calculation inspector panel. Explains one selected result
// (J/S link, ES / sensor / enemy-system / EP ring, or jammer footprint):
// inputs, intermediate values, model, result, and warning flags.
// Content comes from SpecterResults.describeResult(), the same view model the
// report renders. Declarations only: wiring lives in app_init.js.

let inspectorRef = null;   // what the panel is showing; re-resolved on every refresh

// Ring layers and link lines call this so a click opens the inspector. In a
// placement / linking mode the click falls through to the map as before.
function bindInspectOnClick(layer, ref) {
    if (!layer) return;
    layer.on('click', function(e) {
        if (activeMode) return;
        L.DomEvent.stopPropagation(e);
        openInspector(ref);
    });
}

// ── Resolving a ref against live state ────────────────────────────────────
// Returns { record, current } where `current` is the request the app would
// send now; a record whose stored request differs is stale.

function resolveInspectorTarget(ref) {
    if (!ref) return null;
    switch (ref.kind) {
        case 'ea-link': {
            const jLink = jammingLinks.find(l => l.id === ref.jammingLinkId);
            if (!jLink) return null;
            const results = (jLink.results || []).filter(r => r?.record);
            const res = ref.enemyLinkId
                ? results.find(r => r.enemyLinkId === ref.enemyLinkId)
                : results[0];
            const eLink = res && enemyLinks.find(l => l.id === res.enemyLinkId);
            return {
                record: res?.record || null,
                current: eLink ? buildEaPayload(jLink, eLink) : null,
                jLink,
                enemyLinkId: res?.enemyLinkId || ref.enemyLinkId || null,
                siblings: results.map(r => r.enemyLinkId),
            };
        }
        case 'enemy-link': {
            const eLink = enemyLinks.find(l => l.id === ref.enemyLinkId);
            return eLink ? { record: null, eLink } : null;
        }
        case 'es-ring': {
            const node = findNode('red', ref.nodeId);
            return node ? { record: node.esResult || null, current: buildRedRingPayload(node) } : null;
        }
        case 'sensor-coverage': {
            const sensor = findNode('blue', ref.sensorId);
            const tx = findNode('red', ref.redId);
            const cov = sensor?.sensorCoverages?.find(c => c.redId === ref.redId);
            return sensor && tx ? { record: cov?.result || null, current: buildSensorCoveragePayload(sensor, tx) } : null;
        }
        case 'jammer-footprint': {
            const node = findNode('blue', ref.nodeId);
            return node ? { record: node.fpResult || null, current: buildFootprintPayload(node) } : null;
        }
        case 'red-system': {
            const node = findNode('red', ref.nodeId);
            const sys = node?.systems?.find(s => s.id === ref.sysId);
            return sys ? { record: sys.result || null, current: buildRedSystemPayload(node, sys) } : null;
        }
        case 'ep-system': {
            const node = findNode('ep', ref.nodeId);
            const sys = node?.systems?.find(s => s.id === ref.sysId);
            return sys ? { record: sys.result || null, current: buildEpSystemPayload(node, sys) } : null;
        }
        default:
            return null;
    }
}

function isRecordStale(record, current) {
    if (!record || !current) return false;
    return JSON.stringify(current) !== JSON.stringify(record.request);
}

// Records capture names at calculation time; show the current ones.
function liveRecord(record) {
    if (!record) return record;
    const s = record.subject || {};
    const live = (who, type) => {
        if (!who?.id) return who;
        const n = findNode(type, who.id);
        return n ? { id: who.id, name: plainNodeName(n.name) } : who;
    };
    const subject = { ...s };
    if (record.kind === 'ea-link') {
        subject.jammer = live(s.jammer, 'blue');
        subject.transmitter = live(s.transmitter, 'red');
        subject.target = live(s.target, 'red');
    } else {
        const ownerType = { 'jammer-footprint': 'blue', 'ep-system': 'ep' }[record.kind] || 'red';
        subject.node = live(s.node, ownerType);
        if (s.sensor?.id) subject.sensor = live(s.sensor, 'blue');
        if (s.system?.id) {
            const sys = findNode(ownerType, s.node?.id)?.systems?.find(x => x.id === s.system.id);
            if (sys) subject.system = { id: sys.id, name: sys.name };
        }
    }
    return { ...record, subject };
}

// Every calculated result currently held in app state, with its ref and
// staleness. The report uses this, so "everything the inspector can explain"
// and "everything the report lists" are the same set.
function collectResultRecords() {
    const refs = [];
    jammingLinks.forEach(jLink => (jLink.results || []).forEach(r => {
        if (r?.record) refs.push({ kind: 'ea-link', jammingLinkId: jLink.id, enemyLinkId: r.enemyLinkId });
    }));
    redNodes.forEach(node => {
        if (node.esResult) refs.push({ kind: 'es-ring', nodeId: node.id });
        (node.systems || []).forEach(sys => {
            if (sys.result) refs.push({ kind: 'red-system', nodeId: node.id, sysId: sys.id });
        });
    });
    blueNodes.forEach(node => {
        (node.sensorCoverages || []).forEach(cov => {
            if (cov.result) refs.push({ kind: 'sensor-coverage', sensorId: node.id, redId: cov.redId });
        });
        if (node.fpResult) refs.push({ kind: 'jammer-footprint', nodeId: node.id });
    });
    epNodes.forEach(node => (node.systems || []).forEach(sys => {
        if (sys.result) refs.push({ kind: 'ep-system', nodeId: node.id, sysId: sys.id });
    }));
    return refs.map(ref => {
        const target = resolveInspectorTarget(ref);
        return target?.record
            ? { ref, record: liveRecord(target.record), stale: isRecordStale(target.record, target.current) }
            : null;
    }).filter(Boolean);
}

// ── Panel ─────────────────────────────────────────────────────────────────

function openInspector(ref) {
    inspectorRef = { ...ref };
    if (ref.kind === 'ea-link') {
        const target = resolveInspectorTarget(ref);
        if (target?.enemyLinkId) inspectorRef.enemyLinkId = target.enemyLinkId;
        // Mirror the selection on the map and in the results table.
        selectedLink = { type: 'jammer', jammingLinkId: ref.jammingLinkId, enemyLinkId: inspectorRef.enemyLinkId };
        renderResults();   // also refreshes this panel
    } else if (ref.kind === 'enemy-link') {
        selectedLink = { type: 'enemy', jammingLinkId: null, enemyLinkId: ref.enemyLinkId };
        renderResults();
    }
    renderInspector();
}

function closeInspector() {
    inspectorRef = null;
    const panel = document.getElementById('inspector-panel');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}

function refreshInspector() {
    if (inspectorRef) renderInspector();
}

function inspectorHeader(kindLabel, title, subtitle) {
    return `<div class="insp-head">
        <div>
            <div class="insp-kind">${escapeHtml(kindLabel)}</div>
            <h3>${escapeHtml(title)}</h3>
            ${subtitle ? `<div class="insp-sub">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button class="insp-close" onclick="closeInspector()" title="Close (Esc)" aria-label="Close inspector">✕</button>
    </div>`;
}

function renderInspectorView(view, record, extraActions = '') {
    const warnings = view.warnings.slice().sort((a, b) => (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1));
    const computed = new Date(record.computedAt);
    return inspectorHeader(view.kindLabel, view.title, view.subtitle !== view.kindLabel ? view.subtitle : '') +
        `<div class="insp-headline tone-${escapeHtml(view.headline.tone)}">
            <span>${escapeHtml(view.headline.label)}</span>
            <strong>${escapeHtml(view.headline.value)}</strong>
        </div>` +
        (warnings.length ? `<ul class="insp-warnings">${warnings.map(w =>
            `<li class="insp-${escapeHtml(w.level)}">${w.level === 'warn' ? '⚠' : 'ℹ'} ${escapeHtml(w.text)}</li>`).join('')}</ul>` : '') +
        view.models.map(m => `<div class="insp-model">
            <strong>${escapeHtml(m.name)}</strong>
            <p>${escapeHtml(m.summary || '')}</p>
            ${m.validity ? `<small>${escapeHtml(m.validity)}</small>` : ''}
        </div>`).join('') +
        view.sections.map(s => `<details class="insp-section" open>
            <summary>${escapeHtml(s.heading)}</summary>
            <table>${s.rows.map(r => `<tr${r.sub ? ' class="sub"' : ''}><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`).join('')}</table>
        </details>`).join('') +
        `<div class="insp-foot">
            <span>Calculated ${Number.isNaN(computed.getTime()) ? '—' : computed.toLocaleTimeString()}</span>
            ${extraActions}
        </div>`;
}

function renderMissing(message) {
    return inspectorHeader('Inspector', 'No result', '') +
        `<p class="insp-empty">${escapeHtml(message)}</p>`;
}

function renderEnemyLinkInspector(eLink) {
    const tx = findNode('red', eLink.txId);
    const rx = findNode('red', eLink.rxId);
    const eq = tx ? nodeEquipment(tx, 'red') : {};
    const dist = tx && rx ? tx.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000 : null;
    const R = SpecterResults;
    const rows = [
        ['Transmitter', tx ? plainNodeName(tx.name) : eLink.txId],
        ['Receiver', rx ? plainNodeName(rx.name) : eLink.rxId],
        ['Distance', R.fmtKm(dist)],
        ['Frequency', R.fmtMhz(eq.frequency_mhz)],
        ['TX power', R.fmtWatts(eq.tx_power_w)],
        ['Terrain setting', R.terrainLabel(document.getElementById('enemy_terrain').value)],
        ['Frequency hopping', eq.apply_fh ? `Yes, ${R.fmtNum(eq.channel_bw_khz, 1)} kHz channel` : 'No'],
    ];
    const jammers = jammingLinks.filter(j => j.rxId === eLink.rxId).map(j => {
        const res = (j.results || []).find(r => r?.enemyLinkId === eLink.id);
        const label = `${plainNodeName(getNodeDisplayName('blue', j.blueId))}: ${res?.record ? R.fmtSignedDb(res.margin) + ' J/S' : 'pending'}`;
        return res?.record
            ? `<button class="workbench-btn" onclick="openInspector({kind:'ea-link', jammingLinkId:'${j.id}', enemyLinkId:'${eLink.id}'})">${escapeHtml(label)}</button>`
            : `<div class="insp-empty">${escapeHtml(label)}</div>`;
    }).join('');
    return inspectorHeader('Enemy comms link', `${rows[0][1]} → ${rows[1][1]}`, 'The signal the jammers below are trying to deny') +
        `<details class="insp-section" open><summary>Link</summary><table>${rows.map(([l, v]) =>
            `<tr><th>${escapeHtml(l)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table></details>` +
        `<details class="insp-section" open><summary>Jamming results on this link</summary>
            ${jammers || '<p class="insp-empty">No jammer is linked to this receiver.</p>'}
        </details>` +
        `<div class="insp-foot"><span></span><button class="insp-action danger" onclick="removeEnemyLinkById('${eLink.id}'); closeInspector();">Remove link</button></div>`;
}

function renderInspector() {
    const panel = document.getElementById('inspector-panel');
    if (!panel || !inspectorRef) return;
    const target = resolveInspectorTarget(inspectorRef);
    let html;
    if (!target) {
        html = renderMissing('The item this result belonged to has been removed.');
    } else if (inspectorRef.kind === 'enemy-link') {
        html = renderEnemyLinkInspector(target.eLink);
    } else if (!target.record) {
        html = renderMissing('This result is being recalculated, has not been calculated yet, or was cleared by a change. It will appear here when a result is available.');
    } else {
        const record = liveRecord(target.record);
        const view = SpecterResults.describeResult(record, {
            stale: isRecordStale(target.record, target.current),
            legacySchema: loadedScenarioMigration,
        });
        let actions = '';
        if (inspectorRef.kind === 'ea-link') {
            const pairButtons = target.siblings.length > 1
                ? target.siblings.map(id => {
                    const eLink = enemyLinks.find(l => l.id === id);
                    const label = eLink ? `${plainNodeName(getNodeDisplayName('red', eLink.txId))} → ${plainNodeName(getNodeDisplayName('red', eLink.rxId))}` : id;
                    return `<button class="insp-action${id === target.enemyLinkId ? ' active' : ''}" onclick="openInspector({kind:'ea-link', jammingLinkId:'${target.jLink.id}', enemyLinkId:'${id}'})">${escapeHtml(label)}</button>`;
                }).join('')
                : '';
            actions = pairButtons +
                `<button class="insp-action danger" onclick="removeJammingLinkById('${target.jLink.id}'); closeInspector();">Remove jamming link</button>`;
        }
        html = renderInspectorView(view, record, actions);
    }
    // Re-renders happen on every results refresh; keep the reader's place.
    const sameTarget = panel.dataset.ref === JSON.stringify(inspectorRef);
    const scrollTop = sameTarget ? panel.scrollTop : 0;
    panel.innerHTML = html;
    panel.dataset.ref = JSON.stringify(inspectorRef);
    panel.hidden = false;
    panel.scrollTop = scrollTop;
}
