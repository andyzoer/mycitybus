document.addEventListener('DOMContentLoaded', () => {
  const map = L.map('map').setView([50.7472, 25.3254], 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap & CartoDB',
    subdomains: 'abcd'
  }).addTo(map);

  const routeLines = {}, busLayers = {}, stopLayers = {};
  let selected = null; // {route, dir} або null

  const BUS_ROUTES     = ['1','2','3','5','7','9','10','11','12','19','22','24','25','26','26А','27А','28','30','31','32'];
  const TROLLEY_ROUTES = ['1','2','3','4','4А','5','12','15','15А'];
  const ALL_ROUTES = [...BUS_ROUTES.map(r=>'А'+r), ...TROLLEY_ROUTES.map(r=>'T'+r)];

  function getRouteColor(route, dir) {
    const idx = ALL_ROUTES.indexOf(route);
    const hue = (idx / ALL_ROUTES.length) * 360;
    return `hsl(${(hue + dir*60)%360},70%,50%)`;
  }

  function createBadgeIcon(route, bearing, dir) {
    const size=28, c=size/2, r=9, aLen=4;
    const color = route.startsWith('T') ? 'darkblue' : 'black';
    const svg = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
        <polygon points="${c-r/2},${c+r*0.8} ${c+r/2},${c+r*0.8} ${c},${c+r+aLen}"
                 fill="${color}"
                 transform="rotate(${bearing},${c},${c})"/>
        <circle cx="${c}" cy="${c}" r="${r}" fill="${color}" stroke="black"/>
        <text x="${c}" y="${c}" fill="white" font-size="8"
              text-anchor="middle" dominant-baseline="central" font-family="sans-serif">${route}</text>
      </svg>`;
    return L.divIcon({ html: svg, className:'', iconSize:[size,size], iconAnchor:[c,c] });
  }

  function getBusLayer(route, dir) {
    busLayers[route] ||= {};
    return busLayers[route][dir] ||= L.layerGroup();
  }
  function getStopLayer(route, dir) {
    stopLayers[route] ||= {};
    return stopLayers[route][dir] ||= L.layerGroup();
  }

  async function loadRouteAndBuses(route) {
    const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4` +
                `&displayRouteCode=${encodeURIComponent(route)}&direction=&resultType=110000`;
    const { pathList } = await (await fetch(url)).json();
    pathList.forEach(path => {
      const dir = +path.direction;
      if (!routeLines[route]?.[dir] && path.pointList.length) {
        const pts = path.pointList.map(p=>[+p.lat,+p.lng]);
        routeLines[route] ||= {};
        routeLines[route][dir] = L.polyline(pts, { color:getRouteColor(route,dir), weight:3 });
      }
      const layer = getBusLayer(route,dir);
      layer.clearLayers();
      path.busList.forEach(b => {
        const lat=+b.lat, lng=+b.lng, bearing=+b.bearing||0;
        if (isNaN(lat)||isNaN(lng)) return;
        const m = L.marker([lat,lng], { icon:createBadgeIcon(route,bearing,dir) });
        m.on('click', e=>{
          e.originalEvent.stopPropagation();
          selected = {route, dir};
          updateHighlight();
        });
        m.addTo(layer);
      });
    });
  }

  async function loadRouteStops(route) {
    const url = `https://uaservice.kentkart.com/rl1/web/pathInfo?region=118&lang=uk&authType=4` +
                `&displayRouteCode=${encodeURIComponent(route)}&direction=&resultType=0110000`;
    const { pathList } = await (await fetch(url)).json();
    pathList.forEach(path => {
      const dir=+path.direction;
      const layer=getStopLayer(route,dir);
      if (layer.getLayers().length) return;
      path.busStopList.forEach(s=>{
        const lat=+s.lat, lng=+s.lng;
        if (!isNaN(lat)&&!isNaN(lng)) {
          L.circleMarker([lat,lng], { radius:3, fill:'#fff', color:'#000', weight:1 }).addTo(layer);
        }
      });
    });
  }

  function updateHighlight() {
    Object.entries(routeLines).forEach(([route, dirs])=>{
      Object.entries(dirs).forEach(([d, poly])=>{
        const match = selected && route===selected.route && +d===selected.dir;
        poly.setStyle({ opacity: match||!selected ? 1 : 0.2 });
      });
    });
    Object.entries(busLayers).forEach(([route, dirs])=>{
      Object.entries(dirs).forEach(([d, layer])=>{
        layer.eachLayer(marker=>{
          const match = selected && route===selected.route && +d===selected.dir;
          marker.setOpacity(match||!selected ? 1 : 0.2);
        });
      });
    });
    Object.entries(stopLayers).forEach(([route, dirs])=>{
      Object.entries(dirs).forEach(([d, layer])=>{
        layer.eachLayer(stop=>{
          const match = selected && route===selected.route && +d===selected.dir;
          stop.setStyle({ opacity: match||!selected ? 1 : 0.2 });
        });
      });
    });
  }

  function buildSidebar() {
    const sb=document.getElementById('sidebar');
    sb.innerHTML=`
      <label><input type="checkbox" id="toggle-stops"> Показати зупинки</label><hr>
      <div id="routes-list"></div>`;
    const cont=sb.querySelector('#routes-list');
    ALL_ROUTES.forEach(route=>{
      const div=document.createElement('div');
      div.className='route-item';
      div.innerHTML=`
        <div style="min-width:40px;display:inline-block;"><strong>${route}</strong></div>
        <label><input type="checkbox" data-route="${route}" data-dir="0">↑</label>
        <label><input style="margin-left:4px" type="checkbox" data-route="${route}" data-dir="1">↓</label>`;
      cont.append(div);
    });

    cont.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      cb.addEventListener('change', async e=>{
        const r=e.target.dataset.route, d=+e.target.dataset.dir;
        if(e.target.checked){
          await loadRouteAndBuses(r);
          routeLines[r][d].addTo(map);
          getBusLayer(r,d).addTo(map);
          if(document.getElementById('toggle-stops').checked){
            await loadRouteStops(r);
            getStopLayer(r,d).addTo(map);
          }
        } else {
          map.removeLayer(routeLines[r]?.[d]);
          map.removeLayer(getBusLayer(r,d));
          map.removeLayer(getStopLayer(r,d));
        }
      });
    });

    sb.querySelector('#toggle-stops').addEventListener('change', e=>{
      const show=e.target.checked;
      cont.querySelectorAll('input[type=checkbox]:checked').forEach(cb=>{
        const r=cb.dataset.route, d=+cb.dataset.dir;
        if(show){
          loadRouteStops(r).then(()=>getStopLayer(r,d).addTo(map));
        } else {
          map.removeLayer(getStopLayer(r,d));
        }
      });
    });
  }

  map.on('click', ()=>{ selected=null; updateHighlight(); });

  buildSidebar();
const body = document.getElementsByTagName('body')[0];
const sidebar = document.getElementById('sidebar');
const toggle  = document.createElement('div');
toggle.id   = 'sidebar-toggle';
toggle.innerHTML = '&#9664;';
body.appendChild(toggle);

toggle.addEventListener('click', () => {
  body.classList.toggle('sidebar-collapsed');
});
  setInterval(()=>{
    document.querySelectorAll('#routes-list input:checked').forEach(cb=>{
      loadRouteAndBuses(cb.dataset.route);
    });
  },10000);
});