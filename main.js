document.addEventListener('DOMContentLoaded', () => {
  // === Persisted settings ===
  const STORAGE_KEY = 'mycitybus_settings';
  function saveSettings(settings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }
  function loadSettings() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : { selected: [], showStops: false };
  }
  let settings = loadSettings();

  // === 1. Конфігурація ===
  const INITIAL_VIEW = { center: [50.7472, 25.3254], zoom: 13 };
  const GEO_OPTIONS  = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };

  const BUS_ROUTES     = ['1','2','3','5','7','9','10','11','12','19','22','22A','24','25','26','26А','27А','28','30','31','32'];
  const TROLLEY_ROUTES = ['1','2','3','4','4А','5','12','15','15А'];
  const ALL_ROUTES     = [...BUS_ROUTES.map(r => 'А'+r), ...TROLLEY_ROUTES.map(r => 'T'+r)];
  
  const busMarkers = {};  
  const busTimestamps = {};  // busTimestamps[route][dir][busId] = last update ms
  const busPositions = {};  // busPositions[route][dir][busId] = {lat, lng}
  const busBearings = {};    // busBearings[route][dir][busId] = bearing (° від півночі)

let userMarker     = null;
let accuracyCircle = null;
let selectedRoute  = null;   // { route, dir } або null
let showStops      = false;  // чи відображати 
let showRoutes     = true;
let autoCenter     = false;

  // Шари
  const layers = {
    routes: {},  // layers.routes[route][dir] = L.Polyline
    buses:  {},  // layers.buses[route][dir]  = L.LayerGroup
    stops:  {}   // layers.stops[route][dir]  = L.LayerGroup
  };
  // Layer group for nearest stops markers
  const nearestLayer = L.layerGroup();

// === 2. Ініціалізація карти ===
const map = L.map('map', {
  center: INITIAL_VIEW.center,
  zoom:   INITIAL_VIEW.zoom,
  zoomControl: false,
  rotate: true,
  touchRotate: true,
  rotateControl: {
    position: 'bottomright',
    closeOnZeroBearing: false
  }
});

// Disable auto-centering on any user interaction
map.on('movestart zoomstart rotate start', () => {
  autoCenter = false;
});

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap & CartoDB'
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

// === 3. Геолокація ===
map.on('locationfound', e => {
  const { latitude: lat, longitude: lng, accuracy: acc } = e;
  if (!userMarker) {
    userMarker = L.marker([lat, lng], { title: 'Ви тут' }).addTo(map);
    accuracyCircle = L.circle([lat, lng], { radius: acc }).addTo(map);
    // Center map on first location update
    map.setView([lat, lng], map.getZoom());
  } else {
    userMarker.setLatLng([lat, lng]);
    accuracyCircle.setLatLng([lat, lng]).setRadius(acc);
    // Only re-center if autoCenter is true
    if (autoCenter) {
      map.panTo([lat, lng]);
    }
  }
});
map.on('locationerror', e => {
  console.error('Geolocation error:', e.message);
});

  // === 4. Кастомні контролі ===
  // 4.1 Знайти мене
  const LocateControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const c = L.DomUtil.create('div','leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a','',c);
      a.href = '#'; a.title = 'Знайти мене';
      a.innerHTML = '<i class="fas fa-crosshairs"></i>';
      L.DomEvent.disableClickPropagation(c);
      L.DomEvent.on(a, 'click', L.DomEvent.stop)
               .on(a, 'click', () => {
                 autoCenter = true;
                 map.locate({ watch: true, maxZoom: 15, ...GEO_OPTIONS });
               });
      return c;
    }
  });
  map.addControl(new LocateControl());

  // 4.2 Додому
  const HomeControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const c = L.DomUtil.create('div','leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a','',c);
      a.href = '#'; a.title = 'Початковий вигляд';
      a.innerHTML = '<i class="fas fa-home"></i>';
      L.DomEvent.disableClickPropagation(c);
      L.DomEvent.on(a,'click',L.DomEvent.stop)
               .on(a,'click',() => map.setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom));
      return c;
    }
  });
  map.addControl(new HomeControl());


  // === 5. Логіка маршрутів і зупинок ===
  function getRouteColor(route, dir) {
    const idx = ALL_ROUTES.indexOf(route);
    const hue = (idx / ALL_ROUTES.length) * 360;
    return `hsl(${(hue + dir*60)%360},70%,50%)`;
  }

  function createBadgeIcon(route, bearing, dir) {
    const size = 40, c = size/2, r = 15, aLen = 6;
    const color = route.startsWith('T') ? 'darkblue' : 'black';
    const markerTextSize = 14;
    const svg = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <polygon points="${c-r/2},${c+r*0.8} ${c+r/2},${c+r*0.8} ${c},${c+r+aLen}"
                 fill="${color}"
                 transform="rotate(${bearing+180},${c},${c})"/>
        <circle cx="${c}" cy="${c}" r="${r}" fill="${color}" stroke="#000"/>
        <text x="${c}" y="${c}" fill="#fff" font-size="${markerTextSize}"
              text-anchor="middle" dominant-baseline="central"
              font-family="sans-serif">${route}</text>
      </svg>`;
    return L.divIcon({ html: svg, className:'', iconSize:[size,size], iconAnchor:[c,c] });
  }

  function getLayer(group, route, dir) {
    group[route] ||= {};
    return group[route][dir] ||= L.layerGroup();
  }

  // === 6. Плавне оновлення маркерів ===
  async function updateBusMarkers(route, dir) {
    const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4`
              + `&displayRouteCode=${encodeURIComponent(route)}&direction=${dir}&resultType=010000`;
    let json;
  try {
    json = await fetch(url).then(r => r.json());
  } catch (e) {
    console.error('Fetch buses error', e);
    return;
  }

  for (const path of json.pathList || []) {
    const dir = +path.direction;

    // Ініціалізуємо сховища
    layers.buses[route] ||= {};
    busMarkers[route]   ||= {};
    busMarkers[route][dir] ||= {};
    busPositions[route] ||= {};
    busPositions[route][dir] ||= {};
    busBearings[route]  ||= {};
    busBearings[route][dir] ||= {};

    // Ініціалізуємо шар, якщо ще не було
    if (!layers.buses[route][dir]) {
      layers.buses[route][dir] = L.layerGroup().addTo(map);
    }
    const layer    = layers.buses[route][dir];
    const existing = busMarkers[route][dir];
    const seen     = {};

    // Обробка кожного автобуса
    for (const b of path.busList || []) {
      const id      = b.busId;
      const lat     = +b.lat;
      const lng     = +b.lng;
      const bearing = +b.bearing || 0;
      if (isNaN(lat) || isNaN(lng)) continue;

      // Зберігаємо "чистий" азимут автобуса (без урахування кута карти)
      busBearings[route][dir][id] = bearing;

      if (existing[id]) {
        // Порівнюємо з попередньою позицією
        const prev = busPositions[route][dir][id];
        const moved = !prev || Math.abs(prev.lat - lat) > 0.0001 || Math.abs(prev.lng - lng) > 0.0001;
        // Оновлюємо позицію, кут і непрозорість тільки якщо дійсно рух
        existing[id].setLatLng([lat, lng]);
        
        // Оновлюємо іконку з корекцією на поточний кут карти
        const mapBearing = map.getBearing() || 0;
        existing[id].setIcon(createBadgeIcon(route, bearing - mapBearing, dir));

        if (moved) {
          existing[id].setOpacity(1);
          busTimestamps[route] ||= {};
          busTimestamps[route][dir] ||= {};
          busTimestamps[route][dir][id] = Date.now();
        }
      } else {
        // Створюємо новий маркер
        const mapBearing = map.getBearing() || 0;
         const marker = L.marker([lat, lng], {
           icon: createBadgeIcon(route, bearing - mapBearing, dir)
         }).addTo(layer);


        // зробити щойно створений маркер прозорим
        marker.setOpacity(0.7);
        // assign a unique HTML id to the marker's DOM element
        const el = marker.getElement();
        if (el) el.id = `marker-${route}-${id}`;

        marker.on('click', e => {
          e.originalEvent.stopPropagation();
          selectedRoute = { route, dir };
          updateHighlight();
        });

        existing[id] = marker;
        busTimestamps[route] ||= {};
        busTimestamps[route][dir] ||= {};
        busTimestamps[route][dir][id] = Date.now();
      }
      // Зберігаємо нові координати
      busPositions[route][dir][id] = { lat, lng };

      seen[id] = true;
    }

    // Видаляємо маркери, що більше не в списку
    for (const oldId of Object.keys(existing)) {
      if (!seen[oldId]) {
        layer.removeLayer(existing[oldId]);
        delete existing[oldId];
        // remove timestamp
        if (busTimestamps[route]?.[dir]) {
          delete busTimestamps[route][dir][oldId];
        }
        // remove position
        if (busPositions[route]?.[dir]) {
          delete busPositions[route][dir][oldId];
        }
      }
    }
  }
  }

  // Коли починається анімація зуму—додаємо клас, що відключає transition
  map.on('zoomstart', () => {
    map.getContainer().classList.add('disable-marker-transition');
  });

  // Коли анімація зуму завершилася—поновлюємо клас, щоб переходи знову працювали
  map.on('zoomend', () => {
    map.getContainer().classList.remove('disable-marker-transition');
  });

  // Коли починається обертання карти—додаємо клас, що відключає transition
  map.on('rotatestart', () => {
    map.getContainer().classList.add('disable-marker-transition');
  });

  // Коли обертання карти завершилося—відновлюємо transition
  map.on('rotateend', () => {
    map.getContainer().classList.remove('disable-marker-transition');
  });

  // === При обертанні карти оновлюємо іконки автобусів ===
  map.on('rotate', () => {
    const mapBearing = map.getBearing() || 0;
    // Проходимося по всім збереженим чистим азимутам busBearings
    for (const [route, dirs] of Object.entries(busBearings)) {
      for (const [d, bearings] of Object.entries(dirs)) {
        for (const [id, bearing] of Object.entries(bearings)) {
          const marker = busMarkers[route]?.[d]?.[id];
          if (marker) {
            // Перераховуємо іконку з урахуванням кута карти
            marker.setIcon(createBadgeIcon(route, bearing + mapBearing, +d));
          }
        }
      }
    }
  });

  // === 7. Завантажити полілінію і маркери разом ===
  async function loadRoute(route, dir) {
    const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4`
              + `&displayRouteCode=${encodeURIComponent(route)}&direction=${dir}&resultType=110000`;
    let json;
    try { json = await fetch(url).then(r=>r.json()); }
    catch (e) { console.error('Fetch route error',e); return; }

    for (const path of json.pathList||[]) {
      const dir = +path.direction;
      // polyline
      if (!layers.routes[route]?.[dir] && path.pointList.length) {
        const pts = path.pointList.map(p=>[+p.lat,+p.lng]);
        const poly = L.polyline(pts, { color:getRouteColor(route,dir), weight:3 }).addTo(map);;
        layers.routes[route] ||= {};
        layers.routes[route][dir] = poly;
      }
      // markers
      await updateBusMarkers(route, dir);
      // stops
      if (showStops) {
        await loadStops(route, dir);
        getLayer(layers.stops, route, dir).addTo(map);
      }
    }
  }
      async function loadStops(route, dir) {
        const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4`
                  + `&displayRouteCode=${encodeURIComponent(route)}&direction=${dir}&resultType=0110000`;
        let json;
        try { json = await fetch(url).then(r=>r.json()); }
        catch (e) { console.error('Fetch stops error',e); return; }

        for (const path of json.pathList||[]) {
          const dir = +path.direction;
          const stopLayer = getLayer(layers.stops, route, dir);
          if (stopLayer.getLayers().length) continue;
          for (const s of path.busStopList||[]) {
            const name = (s.stopName || s.name || '').toLowerCase();
            const lat = +s.lat, lng = +s.lng;
            if (isNaN(lat)||isNaN(lng)) continue;
            const isGray = name.includes('рейс') || name.includes('тест');
            const marker = L.circleMarker([lat, lng], {
              radius: 5,
              fill: isGray ? '#ccc' : '#fff',
              color: isGray ? '#888' : '#000',
              weight: 1
            }).addTo(stopLayer);

            const stopLabel = s.stopName || s.name || 'Зупинка';
            marker.bindPopup(`<strong>${stopLabel}</strong>`);
            // marker.bindTooltip(stopLabel, {
            //   permanent: true,
            //   direction: 'right',
            //   className: 'stop-label'
            // });
          }
        }
      }

  function updateHighlight() {
    for (const [r, dirs] of Object.entries(layers.routes)) {
      for (const [d, poly] of Object.entries(dirs)) {
        const ok = selectedRoute && selectedRoute.route===r && +selectedRoute.dir===+d;
        poly.setStyle({ opacity: ok||!selectedRoute ? 1 : 0.2 });
      }
    }
    for (const group of [layers.buses, layers.stops]) {
      for (const [r, dirs] of Object.entries(group)) {
        for (const [d, layer] of Object.entries(dirs)) {
          layer.eachLayer(item=>{
            const ok = selectedRoute && selectedRoute.route===r && +selectedRoute.dir===+d;
            if (item.setOpacity)     item.setOpacity(ok||!selectedRoute ? 1 : 0.2);
            else if (item.setStyle)  item.setStyle({ opacity: ok||!selectedRoute ? 1 : 0.2 });
          });
        }
      }
    }
  }

  // === 6. Побудова сайдбару ===
  function buildSidebar() {
    const list = document.getElementById('routes-list');
    ALL_ROUTES.forEach(route => {
      const div = document.createElement('div');
      div.className = 'route-item';
      div.innerHTML = `
        <span style="display:inline-block;min-width:3em;"><strong>${route}</strong></span>
        <label><input type="checkbox" data-route="${route}" data-dir="0">↑</label>
        <label><input type="checkbox" data-route="${route}" data-dir="1">↓</label>
      `;
      list.append(div);
    });

    list.addEventListener('change', async e => {
        const cb = e.target;
        if (!cb.matches('input[type="checkbox"]')) return;

        const route = cb.dataset.route;
        const dir   = +cb.dataset.dir;

        if (cb.checked) {
          // якщо ставимо галочку — завантажуємо полілінію, маркери й (за потреби) зупинки
          await loadRoute(route, dir);
          layers.routes[route][dir]?.addTo(map);
          layers.buses[route][dir]?.addTo(map);
          if (showStops) {
            await loadStops(route, dir);
            layers.stops[route][dir]?.addTo(map);
          }
        } else {
          // якщо знімаємо галочку — ховаємо всі відповідні шари
          if (layers.routes[route]?.[dir]) map.removeLayer(layers.routes[route][dir]);
          if (layers.buses[route]?.[dir])  map.removeLayer(layers.buses[route][dir]);
          if (layers.stops[route]?.[dir])  map.removeLayer(layers.stops[route][dir]);
        }

        // 3) Після будь-якої зміни чекбоксу оновлюємо прогрес-бар
        updateProgressVisibility();
        updateClearButtonState();

        // persist selected checkboxes
        settings.selected = Array.from(
          document.querySelectorAll('#routes-list input[type="checkbox"]:checked')
        ).map(cb => `${cb.dataset.route}_${cb.dataset.dir}`);
        saveSettings(settings);
      });
  }

 // === 11. Кнопки ===
  document.getElementById('toggle-routes-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('is-hidden');
    showRoutes = !showRoutes;
    const btn = document.getElementById('toggle-routes-btn');
    btn.classList.toggle('is-active', showRoutes);
    btn.setAttribute('aria-pressed', showRoutes);
  });

  document.getElementById('toggle-stops-btn').addEventListener('click', () => {
    showStops = !showStops;
    const btn = document.getElementById('toggle-stops-btn');
    btn.classList.toggle('is-active', showStops);
    btn.setAttribute('aria-pressed', showStops);
    // Update button label
    const textSpan = btn.querySelector('span:last-child');
    if (showStops) {
      textSpan.textContent = 'Приховати зупинки';
    } else {
      textSpan.textContent = 'Показувати зупинки';
    }

    settings.showStops = showStops;
    saveSettings(settings);

    document.querySelectorAll('#routes-list input[type=checkbox]:checked')
      .forEach(cb => {
        const r = cb.dataset.route, d = +cb.dataset.dir;
        const stopLayer = getLayer(layers.stops, r, d);
        if (showStops) {
          loadStops(r,d).then(() => stopLayer.addTo(map));
        } else {
         if (stopLayer) map.removeLayer(stopLayer);
        }
      });
  });

  // кнопка "Оновити" — негайне оновлення положення автобусів
  document.getElementById('refresh-btn').addEventListener('click', () => {
    document.querySelectorAll('#routes-list input[type="checkbox"]:checked')
      .forEach(cb => updateBusMarkers(cb.dataset.route, +cb.dataset.dir));
    // перезапустити анімацію прогрес-бару
    startProgressAnimation();
  });

  // кнопка "Переключити напрями" — тoggle directions for each route
  document.getElementById('toggle-dir-btn').addEventListener('click', () => {
    ALL_ROUTES.forEach(route => {
      const upCb = document.querySelector(
        `#routes-list input[data-route="${route}"][data-dir="0"]`
      );
      const downCb = document.querySelector(
        `#routes-list input[data-route="${route}"][data-dir="1"]`
      );
      if (upCb && downCb) {
        // Якщо обидва виключені або обидва ввімкнені — нічого не робимо
        if (upCb.checked && !downCb.checked) {
          // переключаємо з "вгору" на "вниз"
          upCb.checked = false;
          upCb.dispatchEvent(new Event('change', { bubbles: true }));
          downCb.checked = true;
          downCb.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (!upCb.checked && downCb.checked) {
          // переключаємо з "вниз" на "вгору"
          downCb.checked = false;
          downCb.dispatchEvent(new Event('change', { bubbles: true }));
          upCb.checked = true;
          upCb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
  });

  // ===  "Найближчі зупинки" ===
  document.getElementById('nearest-stops-btn').addEventListener('click', async () => {
    const btn = document.getElementById('nearest-stops-btn');
    // If nearestLayer already has markers, clear and hide, and unset button state
    if (nearestLayer.getLayers().length > 0) {
      nearestLayer.clearLayers();
      btn.classList.remove('is-active');
      btn.setAttribute('aria-pressed', 'false');
      return;
    }
    // Otherwise, set button active and fetch & show nearest stops
    btn.classList.add('is-active');
    btn.setAttribute('aria-pressed', 'true');
    const center = map.getCenter();
    const url = `https://uaservice.kentkart.com/rl1/web/nearest/place?region=118&lang=uk&lat=${center.lat}&lng=${center.lng}`;
    let json;
    try { json = await fetch(url).then(r => r.json()); }
    catch (e) {
      console.error('Fetch nearest stops error', e);
      // Reset button if fetch fails
      btn.classList.remove('is-active');
      btn.setAttribute('aria-pressed', 'false');
      return;
    }
    const stops = (json.stopList || []).filter(s => s.routes && s.routes.trim() !== '');
    // create a large marker for each stop
    stops.forEach(s => {
      const lat = +s.lat, lng = +s.lng;
      if (isNaN(lat) || isNaN(lng)) return;
      const name = (s.stopName || '').toLowerCase();
      const isGray = name.includes('рейс') || name.includes('тест');
      const marker = L.circleMarker([lat, lng], {
        radius: 10,
        fillColor: isGray ? '#888' : 'red',
        color: '#fff',
        weight: 2,
        fillOpacity: 0.8,
        id: 0
      }).addTo(nearestLayer);

      const stopLabel = s.stopName || 'Зупинка';
      marker.bindPopup(`<strong>${stopLabel}</strong>`);
      marker.bindTooltip(stopLabel, {
        permanent: true,
        direction: 'right',
        className: 'nearest-stop-label'
      });

      marker.on('click', () => {
        // clear all checked route-directions
        document.querySelectorAll('#routes-list input[type="checkbox"]').forEach(cb => {
          if (cb.checked) {
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        // enable only routes serving this stop
        const routeCodes = (s.routes || '').split(',');
        routeCodes.forEach(routeCode => {
          // both directions 0 and 1
          [0, 1].forEach(d => {
            const cb = document.querySelector(
              `#routes-list input[data-route="${routeCode}"][data-dir="${d}"]`
            );
            if (cb && !cb.checked) {
              cb.checked = true;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
        });
        // remove nearest markers after selection, reset button
        nearestLayer.clearLayers();
        btn.classList.remove('is-active');
        btn.setAttribute('aria-pressed', 'false');
      });
    });
    // add all markers to map
    nearestLayer.addTo(map);
  });

  // 11.x Очистити маршрути — знімає всі галочки і ховає шари маршрутів, автобусів та зупинок
  document.getElementById('clear-routes-btn').addEventListener('click', () => {
    // Знімаємо всі чекбокси
    document.querySelectorAll('#routes-list input[type="checkbox"]').forEach(cb => {
      if (cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    // Очищаємо збережені налаштування маршрутів
    settings.selected = [];
    saveSettings(settings);
    // Оновлюємо прогрес-бар (ховаємо, якщо більше немає видимих маршрутів)
    updateProgressVisibility();
  });

  // дотик по карті ховає sidebar
  const sidebar = document.getElementById('sidebar');
  map.getContainer().addEventListener('pointerdown', e => {
    if (e.pointerType==='touch') {
      selectedRoute = null;
      updateHighlight();
      sidebar.classList.add('is-hidden');
      showRoutes = false;
      const btn = document.getElementById('toggle-routes-btn');
      btn.classList.remove('is-active');
      btn.setAttribute('aria-pressed', showRoutes);
    }
  });

  // клік мишею — лише знімає підсвітку
  map.on('click', () => {
    selectedRoute = null;
    updateHighlight();
  });

  // === 12. Старт ===
  buildSidebar();
  updateClearButtonState();

  // restore selected routes from localStorage
  settings.selected.forEach(key => {
    const [route, dir] = key.split('_');
    const cb = document.querySelector(
      `#routes-list input[data-route="${route}"][data-dir="${dir}"]`
    );
    if (cb) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  updateClearButtonState();

  // restore showStops button
  const stopsBtn = document.getElementById('toggle-stops-btn');
  if (settings.showStops) {
    showStops = true;
    stopsBtn.classList.add('is-active');
    stopsBtn.setAttribute('aria-pressed', 'true');
    stopsBtn.querySelector('span:last-child').textContent = 'Приховувати зупинки';
  }

  const progressContainer = document.getElementById('progress-container');
  // елемент прогрес-бару
  const progressBar = document.getElementById('progress-bar');
  // тривалість між оновленнями (ms) — у вас 10000
  const UPDATE_INTERVAL = 10000;

  // Функція, що повертає true, якщо є хоч один показаний маршрут
  function anyRouteVisible() {
    return document.querySelectorAll('#routes-list input[type=checkbox]:checked').length > 0;
  }

  function updateClearButtonState() {
    const btn = document.getElementById('clear-routes-btn');
    btn.disabled = !anyRouteVisible();
  }

  // Показати/сховати прогрес-бар залежно від наявності видимих маршрутів
  function updateProgressVisibility() {
    if (anyRouteVisible()) {
      progressContainer.style.display = 'block';
    } else {
      progressContainer.style.display = 'none';
    }
  }

  function startProgressAnimation() {
  //  updateProgressVisibility();
    if (!anyRouteVisible()) return;
    // обнуляємо і швидко "скидаємо" transition
    progressBar.style.transition = 'none';
    progressBar.style.width = '0%';
    // даємо браузеру час застосувати стилі
    requestAnimationFrame(() => {
      // через наступний рендер задаємо transition і повну ширину
      progressBar.style.transition = `width ${UPDATE_INTERVAL}ms linear`;
      progressBar.style.width = '100%';
    });
  }

  // Нарешті, перезапускаємо анімацію з інтервалом
  startProgressAnimation();
  setInterval(() => {
    document.querySelectorAll('#routes-list input[type=checkbox]:checked')
      .forEach(cb => updateBusMarkers(cb.dataset.route, +cb.dataset.dir));

    startProgressAnimation();
  }, UPDATE_INTERVAL);

  // make markers that haven't moved for >1 min transparent
  setInterval(() => {
    const now = Date.now();
    for (const [route, dirs] of Object.entries(busMarkers)) {
      for (const [dir, markers] of Object.entries(dirs)) {
        for (const [id, marker] of Object.entries(markers)) {
          const ts = busTimestamps[route]?.[dir]?.[id] || 0;
          const age = now - ts;
          const opacity = age > 60000 ? 0.3 : 1;
          marker.setOpacity(opacity);
        }
      }
    }
  }, 30000);  // check every 30 seconds
});