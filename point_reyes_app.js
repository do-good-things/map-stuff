/* global L */

(function () {
  'use strict';

  let layers = {};           // layers[rider][rideIdx] = L.polyline
  let riderVisible = {};
  let rideVisible = [];

  // ── Map setup ──────────────────────────────────────────
  const map = L.map('map', { center: [38.1, -122.9], zoom: 10, zoomControl: true });

  const STADIA_ATTR = '&copy; <a href="https://www.stadiamaps.com/" target="_blank">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    { attribution: STADIA_ATTR, maxZoom: 20 }).addTo(map);

  L.control.layers(
    {
      'Dark': L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', { attribution: STADIA_ATTR, maxZoom: 20 }),
      'Light': L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', { attribution: STADIA_ATTR, maxZoom: 20 }),
    },
    {},
    { position: 'topright' }
  ).addTo(map);

  // ── Helpers ────────────────────────────────────────────
  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatDate(isoString) {
    if (!isoString) return '';
    try {
      return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  // ── Load ───────────────────────────────────────────────
  fetch('/api/tracks/point_reyes')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      const numRides = Math.max(...Object.values(data).map(info => (info.rides || []).length));
      rideVisible = Array(numRides).fill(true);
      initRiders(data);
      renderTracks(data);
      fitToAllTracks();
    })
    .catch(err => {
      console.error('Error loading tracks:', err);
    });

  // ── Riders ─────────────────────────────────────────────
  function initRiders(data) {
    const container = document.getElementById('rider-list');
    container.innerHTML = '';
    Object.entries(data).forEach(([rider, info]) => {
      riderVisible[rider] = true;
      const row = document.createElement('label');
      row.className = 'check-row';
      row.innerHTML = `
        <span class="rider-dot" style="background:${info.color}"></span>
        <span class="rider-label">${rider}</span>
        <input type="checkbox" class="check-input" data-rider="${rider}" checked />
      `;
      container.appendChild(row);
      row.querySelector('input').addEventListener('change', e => {
        riderVisible[rider] = e.target.checked;
        applyVisibility();
        updateToggleLabel('rider');
      });
    });

    // Toggle all riders
    const toggleLink = document.getElementById('toggle-all-riders');
    if (toggleLink) {
      toggleLink.addEventListener('click', e => {
        e.preventDefault();
        const allChecked = Object.values(riderVisible).every(v => v);
        const newState = !allChecked;
        Object.keys(riderVisible).forEach(r => { riderVisible[r] = newState; });
        document.querySelectorAll('.check-input[data-rider]').forEach(cb => { cb.checked = newState; });
        applyVisibility();
        updateToggleLabel('rider');
      });
    }
  }

  function updateToggleLabel(type) {
    if (type === 'rider') {
      const link = document.getElementById('toggle-all-riders');
      if (!link) return;
      const allChecked = Object.values(riderVisible).every(v => v);
      link.textContent = allChecked ? 'unselect all' : 'select all';
    } else {
      const link = document.getElementById('toggle-all-rides');
      if (!link) return;
      const allChecked = rideVisible.every(v => v);
      link.textContent = allChecked ? 'unselect all' : 'select all';
    }
  }

  // ── Tracks ─────────────────────────────────────────────
  function renderTracks(data) {
    Object.entries(data).forEach(([rider, info]) => {
      layers[rider] = [];
      (info.rides || []).forEach((coords, rideIdx) => {
        if (!coords || coords.length === 0) { layers[rider].push(null); return; }

        const latlngs = coords.map(c => [c[0], c[1]]);
        const poly = L.polyline(latlngs, {
          color: info.color, weight: 3, opacity: 0.85, lineCap: 'round', lineJoin: 'round',
        });

        const s = info.stats && info.stats[rideIdx];
        if (s) {
          const dateStr = formatDate(s.start_time);
          const movStr = s.moving_time_s ? formatDuration(s.moving_time_s) : null;
          const avgStr = s.avg_speed_kmh ? s.avg_speed_kmh.toFixed(1) + ' km/h' : null;
          poly.bindTooltip(
            `<b style="text-transform:capitalize">${rider}</b> · Day ${rideIdx + 1}${dateStr ? ' (' + dateStr + ')' : ''}<br/>` +
            `${s.distance_km} km &nbsp;↑ ${s.elevation_gain_m} m` +
            (movStr ? `<br/>⏱ ${movStr} moving` : '') +
            (avgStr ? ` &nbsp;⚡ ${avgStr} avg` : ''),
            { sticky: true }
          );
        }
        poly.addTo(map);
        layers[rider].push(poly);
      });
    });
  }

  // ── Visibility ─────────────────────────────────────────
  function applyVisibility() {
    Object.entries(layers).forEach(([rider, rideLayers]) => {
      rideLayers.forEach((poly, rideIdx) => {
        if (!poly) return;
        const show = riderVisible[rider] && rideVisible[rideIdx];
        show ? (!map.hasLayer(poly) && poly.addTo(map)) : (map.hasLayer(poly) && map.removeLayer(poly));
      });
    });
  }

  document.querySelectorAll('.check-input[data-ride]').forEach(cb => {
    cb.addEventListener('change', e => {
      rideVisible[parseInt(e.target.dataset.ride, 10)] = e.target.checked;
      applyVisibility();
      updateToggleLabel('ride');
    });
  });

  // Toggle all rides
  const toggleRidesLink = document.getElementById('toggle-all-rides');
  if (toggleRidesLink) {
    toggleRidesLink.addEventListener('click', e => {
      e.preventDefault();
      const allChecked = rideVisible.every(v => v);
      const newState = !allChecked;
      rideVisible = rideVisible.map(() => newState);
      document.querySelectorAll('.check-input[data-ride]').forEach(cb => { cb.checked = newState; });
      applyVisibility();
      updateToggleLabel('ride');
    });
  }

  // ── Fit ────────────────────────────────────────────────
  function fitToAllTracks() {
    const all = [];
    Object.values(layers).forEach(rl => rl.forEach(p => p && all.push(...p.getLatLngs())));
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
  }

})();
