document.addEventListener('DOMContentLoaded', () => {
  // === 1. Конфігурація ===
  const INITIAL_VIEW = { center: [50.7472, 25.3254], zoom: 13 };
  const GEO_OPTIONS  = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };

  const BUS_ROUTES     = ['1','2','3','5','7','9','10','11','12','19','22','22A','24','25','26','26А','27А','28','30','31','32'];
  const TROLLEY_ROUTES = ['1','2','3','4','4А','5','12','15','15А'];
  const ALL_ROUTES     = [...BUS_ROUTES.map(r => 'А'+r), ...TROLLEY_ROUTES.map(r => 'T'+r)];
  
  const busMarkers = {};  
  
  let userMarker     = null;
  let accuracyCircle = null;
  let selectedRoute  = null;   // { route, dir } або null
  let showStops      = false;  // чи відображати 
  let showRoutes     = true;

  // Шари
  const layers = {
    routes: {},  // layers.routes[route][dir] = L.Polyline
    buses:  {},  // layers.buses[route][dir]  = L.LayerGroup
    stops:  {}   // layers.stops[route][dir]  = L.LayerGroup
  };

  // === 2. Ініціалізація карти ===
  const map = L.map('map', {
    center: INITIAL_VIEW.center,
    zoom:   INITIAL_VIEW.zoom,
    zoomControl: false
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
    } else {
      userMarker.setLatLng([lat, lng]);
      accuracyCircle.setLatLng([lat, lng]).setRadius(acc);
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
      L.DomEvent.on(a,'click',L.DomEvent.stop)
               .on(a,'click',() => map.locate({ setView: true, maxZoom: 15, ...GEO_OPTIONS }));
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
  async function updateBusMarkers(route) {
    const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4`
              + `&displayRouteCode=${encodeURIComponent(route)}&direction=&resultType=010000`;
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

      if (existing[id]) {
        // Оновлюємо позицію та кут
        existing[id].setLatLng([lat, lng]);
        existing[id].setIcon(createBadgeIcon(route, bearing, dir));
      } else {
        // Створюємо новий маркер
        const marker = L.marker([lat, lng], {
          icon: createBadgeIcon(route, bearing, dir)
        }).addTo(layer);

        marker.on('click', e => {
          e.originalEvent.stopPropagation();
          selectedRoute = { route, dir };
          updateHighlight();
        });

        existing[id] = marker;
      }

      seen[id] = true;
    }

    // Видаляємо маркери, що більше не в списку
    for (const oldId of Object.keys(existing)) {
      if (!seen[oldId]) {
        layer.removeLayer(existing[oldId]);
        delete existing[oldId];
      }
    }
  }
  }

  // === 7. Завантажити полілінію і маркери разом ===
  async function loadRoute(route) {
    const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4`
              + `&displayRouteCode=${encodeURIComponent(route)}&direction=&resultType=110000`;
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
      await updateBusMarkers(route);
      // stops
      if (showStops) {
        await loadStops(route);
        getLayer(layers.stops, route, dir).addTo(map);
      }
    }
  }
      async function loadStops(route) {
        const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4`
                  + `&displayRouteCode=${encodeURIComponent(route)}&direction=&resultType=0110000`;
        let json;
        try { json = await fetch(url).then(r=>r.json()); }
        catch (e) { console.error('Fetch stops error',e); return; }

        for (const path of json.pathList||[]) {
          const dir = +path.direction;
          const stopLayer = getLayer(layers.stops, route, dir);
          if (stopLayer.getLayers().length) continue;
          for (const s of path.busStopList||[]) {
            const lat = +s.lat, lng = +s.lng;
            if (isNaN(lat)||isNaN(lng)) continue;
            L.circleMarker([lat,lng], {
              radius:3, fill:'#fff', color:'#000', weight:1
            }).addTo(stopLayer)
            .bindPopup(
              `<strong>${s.stopName || s.name || 'Зупинка'}</strong>`
            );
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

    list.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const route = cb.dataset.route, dir = +cb.dataset.dir;
        if (cb.checked) {
          await loadRoute(route);
          const poly = layers.routes[route]?.[dir];
          if (poly) poly.addTo(map);
          getLayer(layers.buses, route, dir).addTo(map);

          if (showStops) {
            await loadStops(route);
            getLayer(layers.stops, route, dir).addTo(map);
          }
        } else {
          if (layers.routes[route]?.[dir]) map.removeLayer(layers.routes[route]?.[dir]);
          if (layers.buses[route]?.[dir]) map.removeLayer(getLayer(layers.buses, route, dir));
          if (layers.stops[route]?.[dir]) map.removeLayer(getLayer(layers.stops, route, dir));
        }
      });
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

    document.querySelectorAll('#routes-list input[type=checkbox]:checked')
      .forEach(cb => {
        const r = cb.dataset.route, d = +cb.dataset.dir;
        const stopLayer = getLayer(layers.stops, r, d);
        if (showStops) {
          loadStops(r).then(() => stopLayer.addTo(map));
        } else {
         if (stopLayer) map.removeLayer(stopLayer);
        }
      });
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
  setInterval(() => {
    document.querySelectorAll('#routes-list input[type=checkbox]:checked')
      .forEach(cb => updateBusMarkers(cb.dataset.route));
  }, 10000);
});