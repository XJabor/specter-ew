// Specter-EW — application wiring. Loaded LAST: every addEventListener,
// Leaflet control registration, and bootstrap call lives here so that
// all functions/state from the earlier files exist before any of it runs.

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') setMode(null);
});

document.getElementById('btn-ep-mode').addEventListener('click', toggleEpMode);

map.on('click', function(e) {
    if      (activeMode === 'place-red')   placeRedNode(e.latlng);
    else if (activeMode === 'place-blue')  placeBlueNode(e.latlng);
    else if (activeMode === 'place-library-red' || activeMode === 'place-library-blue') {
        const template = findNodeTemplate(pendingLibraryPlacement?.templateKey);
        if (!template) return;
        if (activeMode === 'place-library-red') placeRedNode(e.latlng, template);
        else placeBlueNode(e.latlng, template);
        pendingLibraryPlacement = null;
        setMode(null);
    }
    else if (activeMode === 'place-black') placeBlackNode(e.latlng);
    else if (activeMode === 'place-ep')    placeEpNode(e.latlng);
});

// ============================================================
// WORKBENCH BUTTON EVENTS
// ============================================================

document.getElementById('btn-place-red').addEventListener('click',   () => setMode('place-red'));
document.getElementById('btn-place-blue').addEventListener('click',  () => setMode('place-blue'));
document.getElementById('btn-place-black').addEventListener('click', () => setMode('place-black'));
document.getElementById('btn-place-ep').addEventListener('click',    () => setMode('place-ep'));

document.getElementById('btn-link-all-enemy').addEventListener('click', function() {
    if (allCommsLinked()) unlinkAllEnemyComms();
    else                  linkAllEnemyComms();
});

// Collapsible workbench sections: the button owns the caret, the body owns display.
function bindSectionMinimize(btnId, bodyId) {
    document.getElementById(btnId).addEventListener('click', function() {
        const body = document.getElementById(bodyId);
        const minimized = body.style.display === 'none';
        body.style.display = minimized ? 'block' : 'none';
        this.textContent = minimized ? '▼' : '▶';
    });
}

bindSectionMinimize('btn-minimize-links', 'link-statuses-body');
bindSectionMinimize('btn-minimize-red-systems', 'red-systems-list');
bindSectionMinimize('btn-minimize-overlap', 'overlap-body');

document.getElementById('btn-show-overlap').addEventListener('click', computeAndShowOverlap);
document.getElementById('btn-clear-overlap').addEventListener('click', function() {
    clearOverlapLayer();
    markDirty('Overlap overlay cleared.');
});
document.getElementById('btn-toggle-corners').addEventListener('click', toggleCornerMarkers);

// ============================================================
// CLEAR ALL
// ============================================================

document.getElementById('clear-nodes-btn').addEventListener('click', function() {
    resetScenarioState();
    markDirty('Scenario cleared.');
});

// ============================================================
// CENTER ON NODES (LEAFLET CONTROL)
// ============================================================

const CenterControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
        const btn = L.DomUtil.create('button', 'center-nodes-btn');
        btn.innerText = 'Center on Nodes';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', function() {
            const allNodes = [...redNodes, ...blueNodes, ...blackNodes, ...epNodes];
            if (allNodes.length === 0) return;
            const circles = activeSensorCoverages().filter(item => item.coverage.layer).map(item => item.coverage.layer);
            const bounds = L.latLngBounds([]);
            allNodes.forEach(n => bounds.extend(n.marker.getLatLng()));
            circles.forEach(c => bounds.extend(c.getBounds()));
            blueNodes.filter(n => n.footprintCircle).forEach(n => bounds.extend(n.footprintCircle.getBounds()));
            epNodes.forEach(n => n.systems.filter(s => s.layer).forEach(s => bounds.extend(s.layer.getBounds())));
            // Extra right padding accounts for the 280px workbench panel
            map.fitBounds(bounds, {
                paddingTopLeft:     [80, 80],
                paddingBottomRight: [370, 80],
                maxZoom: 16
            });
        });
        return btn;
    }
});
new CenterControl().addTo(map);

// ============================================================
// PARAMETER CHANGE LISTENERS
// ============================================================

document.querySelectorAll('input, select').forEach(element => {
    element.addEventListener('change', function() {
        if (this.closest('#workbench')) return;
        markDirty('Settings changed.');
        syncSelectedNodeFromSidebar(this.id);
        recalculateAll();
    });
});

// ============================================================
// MOBILE SIDEBAR TOGGLE
// ============================================================

const sidebarToggle  = document.getElementById('sidebar-toggle');
const sidebar        = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

sidebarToggle.addEventListener('click', function() {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('visible');
});

sidebarOverlay.addEventListener('click', function() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
});

document.getElementById('sidebar-close').addEventListener('click', function() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
});

document.getElementById('workbench-collapse-btn').addEventListener('click', function() {
    const wb = document.getElementById('workbench');
    wb.classList.toggle('collapsed');
    this.textContent = wb.classList.contains('collapsed') ? '\u25b6' : '\u25bc';
});

document.getElementById('fh_toggle').addEventListener('change', function() {
    updateFrequencyHoppingControls();
    syncSelectedNodeFromSidebar('fh_toggle');
    recalculateAll();
});
updateFrequencyHoppingControls();
initEquipmentLibraryControls();
initScenarioControls();

// ============================================================
// JUMP TO LOCATION
// ============================================================

document.getElementById('btn_search').addEventListener('click', function() {
    let input = document.getElementById('loc_search').value.trim();
    if (!input) return;

    let cleanInput = input.replace(/\s/g, '').toUpperCase();
    let isMGRS = /^[0-9]{1,2}[C-X][A-Z]{2}[0-9]+$/.test(cleanInput);

    if (isMGRS) {
        try {
            let digits = cleanInput.match(/\d+$/)[0];
            if (digits.length % 2 !== 0) {
                alert("MGRS Error: You have an odd number of Easting/Northing digits (" + digits.length + "). You must have an even pair.");
                return;
            }
            let point = mgrs.toPoint(cleanInput);
            map.flyTo([point[1], point[0]], 14);
        } catch (e) {
            alert("MGRS Geometry Error: " + e.message + "\n\nDouble-check that your 100km square letters are valid for your UTM Zone.");
        }
    } else {
        let nums = cleanInput.match(/-?\d+(\.\d+)?/g);
        if (nums && (nums.length === 2 || nums.length === 6)) {
            let lat, lng;
            let isSouth = cleanInput.includes('S');
            let isWest  = cleanInput.includes('W');

            if (nums.length === 2) {
                lat = parseFloat(nums[0]);
                lng = parseFloat(nums[1]);
            } else if (nums.length === 6) {
                lat = Math.abs(parseFloat(nums[0])) + parseFloat(nums[1])/60 + parseFloat(nums[2])/3600;
                lng = Math.abs(parseFloat(nums[3])) + parseFloat(nums[4])/60 + parseFloat(nums[5])/3600;
                if (parseFloat(nums[0]) < 0) lat = -lat;
                if (parseFloat(nums[3]) < 0) lng = -lng;
            }

            if (isSouth && lat > 0) lat = -lat;
            if (isWest  && lng > 0) lng = -lng;

            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                map.flyTo([lat, lng], 14);
            } else {
                alert("Coordinates out of bounds. Check your numbers.");
            }
        } else {
            alert("Could not parse format. Use Decimal (30.46, -86.53), DMS (31°12'09\"N 89°12'40\"W), or MGRS.");
        }
    }
});

document.getElementById('loc_search').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') document.getElementById('btn_search').click();
});

// ============================================================
// LOCAL DATA DIRECTORY PANEL (localhost only)
// ============================================================

(function initDataDirPanel() {
    fetch('/api/data_dir_status')
        .then(r => {
            if (!r.ok) return null;   // 403 for remote users — hide panel silently
            return r.json();
        })
        .then(status => {
            if (!status) return;

            const panel   = document.getElementById('data-dir-panel');
            const pathEl  = document.getElementById('data-dir-path');
            const statEl  = document.getElementById('data-dir-status');
            const input   = document.getElementById('data-dir-input');
            const applyBtn  = document.getElementById('data-dir-apply');
            const rescanBtn = document.getElementById('data-dir-rescan');
            const msgEl   = document.getElementById('data-dir-msg');

            panel.style.display = '';

            function renderStatus(s) {
                pathEl.textContent = s.path;
                statEl.textContent = `${s.dted_cells} DTED cells · ${s.imagery_files} imagery file(s)`;
                if (s.locked) {
                    input.style.display   = 'none';
                    applyBtn.style.display = 'none';
                    msgEl.style.color  = '#aaa';
                    msgEl.textContent  = 'Path locked by environment variable.';
                } else {
                    input.style.display    = '';
                    applyBtn.style.display = '';
                    input.value = s.path;
                    msgEl.textContent = '';
                }
            }

            renderStatus(status);

            applyBtn.addEventListener('click', function () {
                const newPath = input.value.trim();
                if (!newPath) return;
                applyBtn.disabled = true;
                msgEl.style.color = '#aaa';
                msgEl.textContent = 'Scanning…';
                fetch('/api/set_data_dir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newPath }),
                })
                .then(r => r.json())
                .then(result => {
                    applyBtn.disabled = false;
                    if (result.status === 'success') {
                        msgEl.style.color = '#66cc66';
                        msgEl.textContent = 'Applied.';
                        renderStatus(result);
                    } else {
                        msgEl.style.color = '#ff4444';
                        msgEl.textContent = result.message || 'Error applying path.';
                    }
                })
                .catch(() => {
                    applyBtn.disabled = false;
                    msgEl.style.color = '#ff4444';
                    msgEl.textContent = 'Request failed.';
                });
            });

            rescanBtn.addEventListener('click', function () {
                rescanBtn.disabled = true;
                msgEl.style.color  = '#aaa';
                msgEl.textContent  = 'Rescanning…';
                fetch('/api/rescan_data', { method: 'POST' })
                .then(r => r.json())
                .then(result => {
                    rescanBtn.disabled = false;
                    msgEl.style.color  = '#66cc66';
                    msgEl.textContent  = 'Rescan complete.';
                    renderStatus(result);
                })
                .catch(() => {
                    rescanBtn.disabled = false;
                    msgEl.style.color  = '#ff4444';
                    msgEl.textContent  = 'Rescan failed.';
                });
            });
        })
        .catch(() => {});  // network error — panel stays hidden
})();
