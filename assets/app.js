    import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.8.0/dist/maplibre-gl.mjs';

    // Блокируем масштабирование самой HTML-страницы.
    // Обычные wheel/pinch события на карте остаются MapLibre и масштабируют только карту.
    document.addEventListener('wheel', event => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    }, { passive: false });

    document.addEventListener('keydown', event => {
      const isZoomShortcut =
        (event.ctrlKey || event.metaKey) &&
        ['+', '=', '-', '0'].includes(event.key);

      if (isZoomShortcut) {
        event.preventDefault();
      }
    });

    const MONTHS = [
      'Январь','Февраль','Март','Апрель','Май','Июнь',
      'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'
    ];


    const countryPicker = document.getElementById('countryPicker');
    const countryTrigger = document.getElementById('countryTrigger');
    const countryTriggerText = document.getElementById('countryTriggerText');
    const countryDropdown = document.getElementById('countryDropdown');
    const countrySearch = document.getElementById('countrySearch');
    const countryOptions = document.getElementById('countryOptions');
    const countryEmpty = document.getElementById('countryEmpty');
    const monthSelect = document.getElementById('month');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const mapContainer = document.getElementById('map');
    const controlsPanel = document.getElementById('controlsPanel');
    const citySheet = document.getElementById('citySheet');
    const citySheetDrag = document.getElementById('citySheetDrag');
    const citySheetClose = document.getElementById('citySheetClose');
    const citySheetContent = document.getElementById('citySheetContent');
    const countryStatus = document.getElementById('countryStatus');
    const infoTitle = document.getElementById('infoTitle');
    const infoSubtitle = document.getElementById('infoSubtitle');
    const sourceSummary = document.getElementById('sourceSummary');
    const infoNote = document.getElementById('infoNote');
    const cityCount = document.getElementById('count');

    const infoToggle = document.getElementById('infoToggle');
    const infoContent = document.getElementById('infoContent');
    const infoClose = document.getElementById('infoClose');

    const routePanel = document.getElementById('routePanel');
    const routeTitle = document.getElementById('routeTitle');
    const routeStatus = document.getElementById('routeStatus');
    const routeProvider = document.getElementById('routeProvider');
    const routeClose = document.getElementById('routeClose');

    const NATURAL_EARTH_COUNTRIES_URL =
      './data/geography/index.json';
    const CLIMATE_DATA_BASE_URL = './data/climate';

    const COUNTRY_SOURCE_ID = 'selected-country';
    const COUNTRY_FILL_LAYER_ID = 'selected-country-fill';
    const COUNTRY_LINE_LAYER_ID = 'selected-country-line';

    let countryGeoJson = null;
    let countryByCode = new Map();
    let activeCountryCode = 'KAZ';
    let activeCountryName = 'Казахстан';
    let activeCities = [];
    let countryChangeToken = 0;
    let countryEntries = [];
    let userSelectedCountry = false;

    function getProperty(properties, ...names) {
      for (const name of names) {
        const value = properties?.[name];
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return null;
    }

    function getCountryCode(feature) {
      const code = String(getProperty(feature?.properties, 'ADM0_A3', 'adm0_a3', 'SOV_A3', 'sov_a3') || '');
      return /^[A-Z]{3}$/.test(code) ? code : null;
    }

    function getCountryDisplayName(feature) {
      return String(
        getProperty(
          feature?.properties,
          'NAME_RU', 'name_ru', 'NAME_LONG', 'ADMIN', 'NAME', 'admin', 'name'
        ) || getCountryCode(feature) || 'Страна'
      );
    }

    function getPlaceKey(feature, index = 0) {
      return String(getProperty(feature?.properties, 'ne_id', 'NE_ID', 'geonameid', 'GEONAMEID') || `place-${index}`);
    }

    function getPlaceName(feature) {
      return String(
        getProperty(feature?.properties, 'namepar', 'name', 'NAME', 'nameascii', 'NAMEASCII') || 'Город'
      );
    }

    function setCountryStatus(message = '', { error = false } = {}) {
      countryStatus.hidden = !message;
      countryStatus.textContent = message;
      countryStatus.classList.toggle('is-error', error);
    }

    function pluralizeCities(count) {
      const mod10 = count % 10;
      const mod100 = count % 100;
      if (mod10 === 1 && mod100 !== 11) return `${count} город`;
      if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return `${count} города`;
      return `${count} городов`;
    }

    function updateInfoPanel(cities = activeCities) {
      const count = cities.length;
      infoTitle.textContent = `Климатическая карта · ${activeCountryName}`;
      infoSubtitle.textContent =
        `Среднемесячная температура по ${pluralizeCities(count)}. В карточке города — ` +
        'типичная температура ночью/под утро и днём по климатическим нормам 1991–2020.';
      cityCount.textContent = pluralizeCities(count);

      if (activeCountryCode === 'KAZ') {
        sourceSummary.textContent = 'Средняя: Казгидромет 14 · WMO/CRU 7';
        infoNote.textContent =
          'Приоритет источников: Казгидромет → WMO/WorldClim/CRU → вторичные климатические таблицы. ' +
          'Средняя температура маркера для 14 городов берётся напрямую из Казгидромета. ' +
          '«Ночь/день» — отдельные нормы среднего суточного минимума/максимума; их источник указан в карточке города.';
        return;
      }

      const wmoCount = cities.filter(city => city.climateSource === 'wmo').length;
      const cruCount = cities.filter(city => city.climateSource === 'cru').length;
      const parts = [];
      if (wmoCount) parts.push(`WMO 1991–2020: ${wmoCount}`);
      if (cruCount) parts.push(`CRU TS 4.09: ${cruCount}`);
      sourceSummary.textContent = parts.length ? parts.join(' · ') : 'Локальные климатические данные';

      infoNote.textContent =
        'Для остальных стран климатические нормы загружаются только из локальных JSON-файлов. ' +
        'Приоритет при их сборке: WMO Climatological Standard Normals 1991–2020 → CRU TS 4.09. ' +
        'В рантайме карта не обращается к внешним климатическим API.';
    }

    async function fetchCountryClimate(countryCode) {
      const response = await fetch(
        `${CLIMATE_DATA_BASE_URL}/${encodeURIComponent(countryCode)}.json`,
        { cache: 'default' }
      );

      if (!response.ok) {
        throw new Error(`Локальный климатический JSON ${countryCode}: HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload?.cities)) {
        throw new Error(`Некорректный формат ${countryCode}.json`);
      }

      return payload;
    }

    // Deduplicate requests and parsed data; failures can be retried.
    const climateRequests = new Map();
    function loadCountryClimate(code) {
      if (!climateRequests.has(code)) {
        climateRequests.set(code, fetchCountryClimate(code).catch(error => {
          climateRequests.delete(code);
          throw error;
        }));
      }
      return climateRequests.get(code);
    }
    // Start while the map style and tiles load. Attach rejection handling immediately.
    const initialClimate = loadCountryClimate('KAZ').then(
      value => ({ value }),
      error => ({ error }),
    );

    const geometryRequests = new Map();
    function loadCountryGeometry(code) {
      if (!geometryRequests.has(code)) {
        geometryRequests.set(code, fetch(`./data/geography/${encodeURIComponent(code)}.json`)
          .then(response => {
            if (!response.ok) throw new Error(`Country geometry ${code}: HTTP ${response.status}`);
            return response.json();
          }).then(feature => {
            const entry = countryByCode.get(code);
            if (entry) entry.geometry = feature.geometry;
            return feature;
          }).catch(error => {
            geometryRequests.delete(code);
            throw error;
          }));
      }
      return geometryRequests.get(code);
    }

    function collectCoordinates(geometry, target = []) {
      if (!geometry) return target;
      const walk = coordinates => {
        if (!Array.isArray(coordinates)) return;
        if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
          target.push([Number(coordinates[0]), Number(coordinates[1])]);
          return;
        }
        coordinates.forEach(walk);
      };
      walk(geometry.coordinates);
      return target;
    }

    function minimalLongitudeInterval(longitudes) {
      if (!longitudes.length) return [-180, 180];
      const normalized = longitudes.map(lng => ((lng % 360) + 360) % 360).sort((a, b) => a - b);
      if (normalized.length === 1) return [normalized[0], normalized[0]];

      let largestGap = -1;
      let gapIndex = 0;
      for (let i = 0; i < normalized.length; i += 1) {
        const current = normalized[i];
        const next = i === normalized.length - 1 ? normalized[0] + 360 : normalized[i + 1];
        const gap = next - current;
        if (gap > largestGap) {
          largestGap = gap;
          gapIndex = i;
        }
      }

      let west = normalized[(gapIndex + 1) % normalized.length];
      let east = normalized[gapIndex];
      if (east < west) east += 360;
      while (west > 180) { west -= 360; east -= 360; }
      return [west, east];
    }

    function countryBounds(feature) {
      const coordinates = collectCoordinates(feature?.geometry);
      if (!coordinates.length) return null;

      // Не используем Math.min(...largeArray): у сложных полигонов стран
      // десятки тысяч вершин, и spread может превысить лимит аргументов JS.
      let south = Infinity;
      let north = -Infinity;
      const longitudes = [];
      for (const [lng, lat] of coordinates) {
        longitudes.push(lng);
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }

      const [west, east] = minimalLongitudeInterval(longitudes);
      return { west, east, south, north };
    }

    function boundsFromPoints(points) {
      const valid = points.filter(
        point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
      );
      if (!valid.length) return null;

      let south = Infinity;
      let north = -Infinity;
      const longitudes = [];

      for (const [lng, lat] of valid) {
        longitudes.push(lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }

      const [west, east] = minimalLongitudeInterval(longitudes);
      return { west, east, south, north };
    }

    function cityBounds(cities = []) {
      return boundsFromPoints(
        cities.map(city => [Number(city.lng), Number(city.lat)])
      );
    }

    function expandBounds(bounds, {
      lngRatio = 0.22,
      latRatio = 0.18,
      minLngPad = 0.55,
      minLatPad = 0.45
    } = {}) {
      const width = Math.max(0.1, bounds.east - bounds.west);
      const height = Math.max(0.1, bounds.north - bounds.south);
      const lngPad = Math.max(minLngPad, width * lngRatio);
      const latPad = Math.max(minLatPad, height * latRatio);

      return {
        west: bounds.west - lngPad,
        east: bounds.east + lngPad,
        south: Math.max(-84, bounds.south - latPad),
        north: Math.min(84, bounds.north + latPad)
      };
    }

    function countryViewBounds(feature, cities = []) {
      const geometryBounds = countryBounds(feature);
      const markersBounds = cityBounds(cities);

      if (!geometryBounds) return markersBounds;
      if (!markersBounds || cities.length < 2) return geometryBounds;

      const geometryWidth = Math.max(0.1, geometryBounds.east - geometryBounds.west);
      const geometryHeight = Math.max(0.1, geometryBounds.north - geometryBounds.south);
      const markerWidth = Math.max(0.1, markersBounds.east - markersBounds.west);
      const markerHeight = Math.max(0.1, markersBounds.north - markersBounds.south);

      // У некоторых стран в одной геометрии есть очень удалённые территории/острова.
      // Если полный bbox во много раз больше области с климатическими городами,
      // фреймим именно рабочую (населённую) область карты. Это исправляет, например,
      // Норвегию и аналогичные составные геометрии, не меняя подсветку самой страны.
      const hasRemoteGeometry =
        geometryWidth > markerWidth * 3.2 ||
        geometryHeight > markerHeight * 3.2 ||
        (geometryWidth > 80 && markerWidth < 35) ||
        (geometryHeight > 55 && markerHeight < 24);

      if (hasRemoteGeometry) {
        return expandBounds(markersBounds, {
          lngRatio: 0.32,
          latRatio: 0.28,
          minLngPad: 0.9,
          minLatPad: 0.7
        });
      }

      return geometryBounds;
    }

    function paddedCountryBounds(bounds) {
      const expanded = expandBounds(bounds, {
        lngRatio: 0.32,
        latRatio: 0.32,
        minLngPad: 0.8,
        minLatPad: 0.65
      });

      return [
        [expanded.west, expanded.south],
        [expanded.east, expanded.north]
      ];
    }

    function updateCountryLayer(feature) {
      const source = map.getSource(COUNTRY_SOURCE_ID);
      if (!source || !feature) return;
      source.setData({ type: 'FeatureCollection', features: [feature] });
    }

    function fitToCountry(feature, { animate = true, cities = activeCities } = {}) {
      const bounds = countryViewBounds(feature, cities);
      if (!bounds) return;

      const mapBounds = [[bounds.west, bounds.south], [bounds.east, bounds.north]];
      const cameraPadding = {
        top: isMobileViewport() ? 92 : 80,
        right: isMobileViewport() ? 28 : 55,
        bottom: 45,
        left: isMobileViewport() ? 28 : 230
      };

      // Снимаем ограничение предыдущей страны перед расчётом новой камеры.
      // Иначе после маленькой страны нельзя корректно перейти к большой.
      map.setMinZoom(1);
      map.setMaxBounds(null);

      const camera = map.cameraForBounds(mapBounds, {
        padding: cameraPadding,
        maxZoom: 7.5
      });
      const targetZoom = Math.min(camera?.zoom ?? 4, 7.5);

      // Разрешаем отдалиться лишь немного относительно масштаба выбранной страны.
      // Раньше minZoom=1 позволял после выбора Норвегии снова увидеть почти весь мир.
      const countryMinZoom = Math.max(1, Math.min(6.9, targetZoom - 0.65));

      map.setMaxBounds(paddedCountryBounds(bounds));
      map.fitBounds(mapBounds, {
        padding: cameraPadding,
        maxZoom: 7.5,
        duration: animate ? 650 : 0,
        essential: true
      });
      map.setMinZoom(countryMinZoom);
    }

    function addCountryLayerIfNeeded() {
      if (map.getSource(COUNTRY_SOURCE_ID)) return;
      map.addSource(COUNTRY_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      const firstSymbolLayerId = map.getStyle().layers?.find(layer => layer.type === 'symbol')?.id;
      map.addLayer({
        id: COUNTRY_FILL_LAYER_ID,
        type: 'fill',
        source: COUNTRY_SOURCE_ID,
        paint: {
          'fill-color': '#2563eb',
          'fill-opacity': 0.035
        }
      }, firstSymbolLayerId);
      map.addLayer({
        id: COUNTRY_LINE_LAYER_ID,
        type: 'line',
        source: COUNTRY_SOURCE_ID,
        paint: {
          'line-color': '#0f172a',
          'line-width': 1.4,
          'line-opacity': 0.45
        }
      }, firstSymbolLayerId);
    }

    function normalizeCountrySearch(value) {
      return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('ru').trim();
    }

    function countrySearchKey(feature, code, displayName) {
      const aliases = [
        displayName, code,
        getProperty(feature?.properties, 'NAME', 'name'),
        getProperty(feature?.properties, 'NAME_EN', 'name_en'),
        getProperty(feature?.properties, 'NAME_LONG', 'name_long'),
        getProperty(feature?.properties, 'ADMIN', 'admin'),
        getProperty(feature?.properties, 'SOVEREIGNT', 'sovereignt')
      ];
      return normalizeCountrySearch(aliases.filter(Boolean).join(' '));
    }

    function setCountryPickerDisabled(disabled) {
      countryTrigger.disabled = disabled;
      if (disabled) closeCountryDropdown();
    }

    function selectedCountryEntry() {
      return countryEntries.find(entry => entry.code === activeCountryCode) || null;
    }

    function syncCountryPickerSelection() {
      const selected = selectedCountryEntry();
      countryTriggerText.textContent = selected?.name || activeCountryName || activeCountryCode;
      countryTrigger.title = countryTriggerText.textContent;
      countryOptions.querySelectorAll('.country-option').forEach(option => {
        option.setAttribute('aria-selected', String(option.dataset.countryCode === activeCountryCode));
      });
    }

    function renderCountryOptions(query = '') {
      const normalizedQuery = normalizeCountrySearch(query);
      const filtered = normalizedQuery ? countryEntries.filter(entry => entry.searchKey.includes(normalizedQuery)) : countryEntries;
      const fragment = document.createDocumentFragment();
      filtered.forEach(({ code, name }) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'country-option';
        option.dataset.countryCode = code;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(code === activeCountryCode));
        const nameEl = document.createElement('span');
        nameEl.textContent = name;
        const codeEl = document.createElement('span');
        codeEl.className = 'country-option-code';
        codeEl.textContent = code;
        option.append(nameEl, codeEl);
        fragment.appendChild(option);
      });
      countryOptions.replaceChildren(fragment);
      countryEmpty.hidden = filtered.length > 0;
    }

    function openCountryDropdown() {
      if (countryTrigger.disabled) return;
      countryDropdown.hidden = false;
      countryTrigger.setAttribute('aria-expanded', 'true');
      countrySearch.value = '';
      renderCountryOptions();
      requestAnimationFrame(() => {
        countrySearch.focus({ preventScroll: true });
        countryOptions.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      });
    }

    function closeCountryDropdown({ focusTrigger = false } = {}) {
      countryDropdown.hidden = true;
      countryTrigger.setAttribute('aria-expanded', 'false');
      countrySearch.value = '';
      if (focusTrigger) countryTrigger.focus({ preventScroll: true });
    }

    function toggleCountryDropdown() {
      countryDropdown.hidden ? openCountryDropdown() : closeCountryDropdown();
    }

    function chooseCountry(code) {
      if (!countryByCode.has(code)) return;
      closeCountryDropdown({ focusTrigger: true });
      if (code !== activeCountryCode) setActiveCountry(code);
    }

    function moveCountryOptionFocus(direction) {
      const options = [...countryOptions.querySelectorAll('.country-option')];
      if (!options.length) return;
      const currentIndex = options.indexOf(document.activeElement);
      const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : options.length - 1) : (currentIndex + direction + options.length) % options.length;
      options[nextIndex].focus();
      options[nextIndex].scrollIntoView({ block: 'nearest' });
    }

    function fillCountryPicker() {
      const collator = new Intl.Collator('ru', { sensitivity: 'base' });
      countryEntries = [...countryByCode.entries()]
        .filter(([code]) => code !== 'ATA')
        .map(([code, feature]) => {
          const name = getCountryDisplayName(feature);
          return { code, name, searchKey: countrySearchKey(feature, code, name) };
        })
        .sort((a, b) => {
          if (a.code === 'KAZ') return -1;
          if (b.code === 'KAZ') return 1;
          return collator.compare(a.name, b.name);
        });
      renderCountryOptions();
      syncCountryPickerSelection();
      setCountryPickerDisabled(false);
    }

    // Нормализуем долготу вершины относительно пользовательской точки.
    // Это позволяет корректно проверять полигоны, пересекающие ±180°.
    function longitudeNearPoint(lng, pointLng) {
      let normalized = lng;
      while (normalized - pointLng > 180) normalized -= 360;
      while (normalized - pointLng < -180) normalized += 360;
      return normalized;
    }

    function pointInRing(lng, lat, ring) {
      let inside = false;

      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = longitudeNearPoint(ring[i][0], lng);
        const yi = ring[i][1];
        const xj = longitudeNearPoint(ring[j][0], lng);
        const yj = ring[j][1];

        const crossesLatitude = (yi > lat) !== (yj > lat);
        if (!crossesLatitude) continue;

        const edgeLng = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (lng < edgeLng) inside = !inside;
      }

      return inside;
    }

    function pointInPolygonCoordinates(lng, lat, polygon) {
      if (!polygon?.length || !pointInRing(lng, lat, polygon[0])) return false;

      // Последующие кольца — отверстия внутри основного полигона.
      for (let i = 1; i < polygon.length; i += 1) {
        if (pointInRing(lng, lat, polygon[i])) return false;
      }

      return true;
    }

    function featureContainsPoint(feature, lng, lat) {
      const geometry = feature?.geometry;
      if (!geometry) return false;

      if (geometry.type === 'Polygon') {
        return pointInPolygonCoordinates(lng, lat, geometry.coordinates);
      }

      if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some(polygon =>
          pointInPolygonCoordinates(lng, lat, polygon)
        );
      }

      return false;
    }

    async function countryAtCoordinates(lng, lat) {
      for (const [code, feature] of countryByCode.entries()) {
        if (code === 'ATA') continue;
        if (!feature.bounds.some(([west, south, east, north]) =>
          lng >= west && lng <= east && lat >= south && lat <= north)) continue;
        const detailed = await loadCountryGeometry(code);
        if (featureContainsPoint(detailed, lng, lat)) return code;
      }

      return null;
    }

    function getApproximateCurrentPosition() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Геолокация не поддерживается этим браузером'));
          return;
        }

        navigator.geolocation.getCurrentPosition(resolve, reject, {
          // Для определения страны точность GPS не нужна: так быстрее и экономнее.
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 10 * 60 * 1000
        });
      });
    }

    async function openCountryFromCurrentLocation() {
      try {
        const position = await getApproximateCurrentPosition();
        if (userSelectedCountry) return;

        const { longitude, latitude } = position.coords;
        const detectedCountry = await countryAtCoordinates(longitude, latitude);
        if (userSelectedCountry) return;

        if (!detectedCountry || detectedCountry === activeCountryCode) return;
        if (!countryByCode.has(detectedCountry)) return;

        await setActiveCountry(detectedCountry);
      } catch (error) {
        // Разрешение на геолокацию необязательно: при отказе остаётся Казахстан.
        console.info('Country autodetection skipped:', error?.message || error);
      }
    }

    async function loadGlobalGeography() {
      setCountryStatus('Загружаю список стран…');
      const countriesResponse = await fetch(
        NATURAL_EARTH_COUNTRIES_URL,
        { cache: 'default' }
      );
      if (!countriesResponse.ok) {
        throw new Error('Не удалось загрузить Natural Earth');
      }

      countryGeoJson = await countriesResponse.json();

      countryByCode = new Map();
      countryGeoJson.features.forEach(feature => {
        const code = getCountryCode(feature);
        if (code && !countryByCode.has(code)) countryByCode.set(code, feature);
      });

      fillCountryPicker();
      addCountryLayerIfNeeded();
      const initialCode = activeCountryCode;
      try {
        const initialFeature = await loadCountryGeometry(initialCode);
        if (activeCountryCode === initialCode) updateCountryLayer(initialFeature);
      } catch (error) {
        console.warn('Country outline unavailable:', error);
      }
      if (countryChangeToken === 0) setCountryStatus('');

      // После загрузки границ определяем страну пользователя локально,
      // без reverse-geocoding API и дополнительных сетевых запросов.
      openCountryFromCurrentLocation();
    }

    async function setActiveCountry(countryCode) {
      const token = ++countryChangeToken;
      const feature = countryByCode.get(countryCode);
      if (!feature) return;

      clearRoute();
      closePopup();
      setInfoExpanded(false);
      activeCountryCode = countryCode;
      activeCountryName = getCountryDisplayName(feature);
      syncCountryPickerSelection();
      updateCountryLayer(feature);

      activeCities = [];
      updateInfoPanel();
      renderMarkers();
      setCountryStatus(`Загружаю локальные данные для ${activeCountryName}…`);

      try {
        const [climateResult, geometryResult] = await Promise.allSettled([
          loadCountryClimate(countryCode), loadCountryGeometry(countryCode)
        ]);
        if (climateResult.status === 'rejected') throw climateResult.reason;
        const payload = climateResult.value;
        if (token !== countryChangeToken) return;

        updateCountryLayer(feature);
        activeCountryName = payload.countryName || activeCountryName;
        activeCities = payload.cities;
        syncCountryPickerSelection();
        updateInfoPanel();
        renderMarkers();
        fitToCountry(feature, { cities: activeCities });
        setCountryStatus(geometryResult.status === 'rejected'
          ? 'Граница страны недоступна. Климатические данные загружены.' : '');
      } catch (error) {
        if (token !== countryChangeToken) return;
        console.error('Country climate JSON load failed:', error);

        activeCities = [];
        updateInfoPanel();
        renderMarkers();
        // Даже без климатического JSON не оставляем ограничения от предыдущей страны.
        fitToCountry(feature, { cities: [] });
        setCountryStatus(
          `Нет локального файла data/climate/${countryCode}.json. ` +
          'Сначала выполните статическую сборку климатических данных.',
          { error: true }
        );
      }
    }

    function setInfoExpanded(expanded) {
      infoToggle.setAttribute('aria-expanded', String(expanded));
      infoContent.hidden = !expanded;
    }

    infoToggle.addEventListener('click', event => {
      event.stopPropagation();
      closeCountryDropdown();
      const expanded = infoToggle.getAttribute('aria-expanded') === 'true';
      setInfoExpanded(!expanded);
    });

    infoClose.addEventListener('click', event => {
      event.stopPropagation();
      setInfoExpanded(false);
    });


    // По умолчанию открываем текущий месяц пользователя.
    MONTHS.forEach((month, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = month;
      monthSelect.appendChild(option);
    });
    monthSelect.value = String(new Date().getMonth());

    countryTrigger.addEventListener('click', event => {
      event.stopPropagation();
      toggleCountryDropdown();
    });

    countryTrigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openCountryDropdown();
      }
    });

    countrySearch.addEventListener('input', () => renderCountryOptions(countrySearch.value));

    countrySearch.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCountryDropdown({ focusTrigger: true });
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveCountryOptionFocus(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveCountryOptionFocus(-1);
      } else if (event.key === 'Enter') {
        const first = countryOptions.querySelector('.country-option');
        if (first) {
          event.preventDefault();
          chooseCountry(first.dataset.countryCode);
        }
      }
    });

    countryOptions.addEventListener('click', event => {
      const option = event.target.closest('.country-option');
      if (option) chooseCountry(option.dataset.countryCode);
    });

    countryOptions.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCountryDropdown({ focusTrigger: true });
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveCountryOptionFocus(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveCountryOptionFocus(-1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        const option = event.target.closest('.country-option');
        if (option) {
          event.preventDefault();
          chooseCountry(option.dataset.countryCode);
        }
      }
    });

    document.addEventListener('pointerdown', event => {
      if (!countryPicker.contains(event.target)) closeCountryDropdown();
    });

    function hasTemperature(value) {
      return Number.isFinite(value) && value > -90 && value < 60;
    }

    function formatTemp(value, missingText = '—') {
      if (!hasTemperature(value)) return missingText;
      return `${value > 0 ? '+' : ''}${value.toFixed(1)}°C`;
    }

    function temperatureColor(temp) {
      if (!hasTemperature(temp)) return '#64748b';
      if (temp <= -15) return '#1d4ed8';
      if (temp <= -8)  return '#2563eb';
      if (temp <= -2)  return '#0891b2';
      if (temp <= 5)   return '#16a34a';
      if (temp <= 12)  return '#ca8a04';
      if (temp <= 20)  return '#ea580c';
      return '#dc2626';
    }

    function createMarkerElement(city, monthIndex) {
      const temp = city.temps[monthIndex];

      const el = document.createElement('div');
      el.className = 'temperature-marker';
      el.title = hasTemperature(temp)
        ? `${city.name}: ${formatTemp(temp)}`
        : `${city.name}: нет данных за ${MONTHS[monthIndex].toLocaleLowerCase('ru')}`;

      const badge = document.createElement('div');
      badge.className = 'temperature-badge';
      badge.style.background = temperatureColor(temp);
      badge.textContent = formatTemp(temp);
      if (!hasTemperature(temp)) badge.classList.add('temperature-badge-missing');

      const cityEl = document.createElement('div');
      cityEl.className = 'temperature-city';
      cityEl.textContent = city.name;

      el.append(badge, cityEl);
      return el;
    }

    function sourceBadge(tier) {
      if (tier === 'primary') {
        return '<span class="source-badge source-badge-primary">первичный</span>';
      }
      if (tier === 'wmo' || tier === 'fallback') {
        return '<span class="source-badge source-badge-fallback">WMO-норма</span>';
      }
      if (tier === 'cru') {
        return '<span class="source-badge source-badge-fallback">CRU 0.5°</span>';
      }
      return '<span class="source-badge source-badge-secondary">вторичный</span>';
    }

    function popupHtml(city, monthIndex) {
      const temp = city.temps[monthIndex];
      const avgLow = city.avgLow?.[monthIndex] ?? null;
      const avgHigh = city.avgHigh?.[monthIndex] ?? null;
      const alt = city.alt == null ? 'не указана' : `${city.alt} м`;
      const color = temperatureColor(temp);
      const hasMissingClimateValue = [temp, avgLow, avgHigh].some(
        value => !hasTemperature(value),
      );
      const missingClimateNote = hasMissingClimateValue
        ? '<div class="popup-climate-missing">Значение за этот месяц отсутствует в источнике.</div>'
        : '';

      return `
        <div class="popup">
          <div class="popup-head" style="background:${color}">
            <div class="popup-city">${city.name}</div>
            <div class="popup-temp">${formatTemp(temp, 'Нет данных')}</div>
          </div>

          <div class="popup-body">
            <div>
              <strong>${MONTHS[monthIndex]}</strong> · климатические нормы ${city.temperaturePeriod || '1991–2020'}
            </div>

            <div class="popup-climate-range">
              <div class="popup-climate-item">
                <span class="popup-climate-label">🌙 Ночью / под утро</span>
                <span class="popup-climate-value">${formatTemp(avgLow)}</span>
              </div>

              <div class="popup-climate-item">
                <span class="popup-climate-label">Средняя за месяц</span>
                <span class="popup-climate-value">${formatTemp(temp)}</span>
              </div>

              <div class="popup-climate-item">
                <span class="popup-climate-label">☀️ Днём</span>
                <span class="popup-climate-value">${formatTemp(avgHigh)}</span>
              </div>
            </div>

            <div class="popup-climate-note">
              «Ночью / под утро» — средний суточный минимум,
              «днём» — средний суточный максимум. Это климатология, не прогноз.
            </div>
            ${missingClimateNote}

            <div class="popup-row popup-location">
              Высота метеостанции: ${alt}
            </div>
            <div class="popup-row">
              Координаты: ${city.lat.toFixed(2)}°, ${city.lng.toFixed(2)}°
            </div>

            <button class="route-button" type="button" data-route-city="${city.name}">
              <span aria-hidden="true">🚗</span>
              <span>Проложить маршрут</span>
            </button>

            <div class="popup-sources">
              <div class="popup-source-row">
                <span class="popup-source-label">Средняя</span>
                <a href="${city.meanSourceUrl}" target="_blank" rel="noopener noreferrer">
                  ${city.meanSourceName}${sourceBadge(city.meanSourceTier)}
                </a>
              </div>

              <div class="popup-source-row">
                <span class="popup-source-label">Ночь / день</span>
                <a href="${city.rangeSourceUrl}" target="_blank" rel="noopener noreferrer">
                  ${city.rangeSourceName}${sourceBadge(city.rangeSourceTier)}
                </a>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [67.5, 48.2],
      zoom: 4.15,
      minZoom: 3,
      maxZoom: 15,
      pitch: 0,
      bearing: 0,
      attributionControl: false
    });

    // Стандартные интерактивные контролы.
    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true,
        showCompass: true,
        showZoom: true
      }),
      'top-right'
    );

    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: 'OpenFreeMap · OpenStreetMap'
      }),
      'bottom-right'
    );

    // Географически ограничиваем основной рабочий район,
    // но оставляем небольшой запас вокруг Казахстана.
    map.setMaxBounds([
      [40.0, 36.0],
      [94.0, 59.5]
    ]);

    const markers = [];
    let activePopup = null;
    let activeCity = null;

    const ROUTE_SOURCE_ID = 'active-route';
    const ROUTE_CASING_LAYER_ID = 'active-route-casing';
    const ROUTE_LAYER_ID = 'active-route-line';
    const VALHALLA_ROUTE_URL = 'https://valhalla1.openstreetmap.de/route';
    const OSRM_ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving';

    let currentLocationMarker = null;
    let routeRequestController = null;
    let activeRouteDestination = null;

    function closePopup() {
      if (activePopup) {
        activePopup.remove();
        activePopup = null;
      }

      citySheet.hidden = true;
      citySheet.style.removeProperty('transform');
      citySheet.style.removeProperty('transition');
      citySheetContent.replaceChildren();
      activeCity = null;
    }

    citySheetClose.addEventListener('click', event => {
      event.stopPropagation();
      closePopup();
    });

    let citySheetDragStartY = null;
    let citySheetDragOffset = 0;
    let citySheetDragPointer = null;

    citySheetDrag.addEventListener('pointerdown', event => {
      if (citySheet.hidden) return;

      citySheetDragStartY = event.clientY;
      citySheetDragOffset = 0;
      citySheetDragPointer = event.pointerId;
      citySheet.style.transition = 'none';
      citySheetDrag.setPointerCapture?.(event.pointerId);
    });

    citySheetDrag.addEventListener('pointermove', event => {
      if (event.pointerId !== citySheetDragPointer || citySheetDragStartY == null) return;

      citySheetDragOffset = Math.max(0, event.clientY - citySheetDragStartY);
      citySheet.style.transform = `translateY(${citySheetDragOffset}px)`;
      event.preventDefault();
    });

    function finishCitySheetDrag(event, cancelled = false) {
      if (event.pointerId !== citySheetDragPointer || citySheetDragStartY == null) return;

      if (!cancelled) {
        citySheetDragOffset = Math.max(citySheetDragOffset, event.clientY - citySheetDragStartY);
      }

      if (citySheetDrag.hasPointerCapture?.(event.pointerId)) {
        citySheetDrag.releasePointerCapture(event.pointerId);
      }
      citySheetDragStartY = null;
      citySheetDragPointer = null;

      if (!cancelled && citySheetDragOffset > 72) {
        closePopup();
        return;
      }

      citySheetDragOffset = 0;
      citySheet.style.transition = 'transform .16s ease-out';
      citySheet.style.transform = 'translateY(0)';
      window.setTimeout(() => {
        if (!citySheet.hidden) citySheet.style.removeProperty('transition');
      }, 180);
    }

    citySheetDrag.addEventListener('pointerup', event => finishCitySheetDrag(event));
    citySheetDrag.addEventListener('pointercancel', event => finishCitySheetDrag(event, true));

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (activePopup || !citySheet.hidden)) {
        closePopup();
      }
    });

    function setRoutePanel({ destination, status, provider = 'Маршрут по дорогам OpenStreetMap', error = false }) {
      routePanel.hidden = false;
      routePanel.classList.toggle('route-error', error);
      routeTitle.textContent = destination ? `До ${destination}` : 'Маршрут';
      routeStatus.textContent = status;
      routeProvider.textContent = provider;
    }

    function formatRouteDistance(kilometers) {
      if (!Number.isFinite(kilometers)) return 'н/д';
      return kilometers < 100
        ? `${kilometers.toFixed(1)} км`
        : `${Math.round(kilometers).toLocaleString('ru-RU')} км`;
    }

    function formatRouteDuration(seconds) {
      if (!Number.isFinite(seconds)) return 'н/д';

      const totalMinutes = Math.max(1, Math.round(seconds / 60));
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      const parts = [];

      if (days) parts.push(`${days} д`);
      if (hours) parts.push(`${hours} ч`);
      if (minutes || parts.length === 0) parts.push(`${minutes} мин`);

      return parts.join(' ');
    }

    // Valhalla по умолчанию возвращает геометрию маршрута в polyline6.
    // Декодируем её в координаты MapLibre [lng, lat].
    function decodePolyline6(encoded) {
      const coordinates = [];
      let index = 0;
      let lat = 0;
      let lng = 0;

      while (index < encoded.length) {
        let result = 0;
        let shift = 0;
        let byte;

        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20 && index < encoded.length);

        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        result = 0;
        shift = 0;

        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20 && index < encoded.length);

        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        coordinates.push([lng / 1e6, lat / 1e6]);
      }

      return coordinates;
    }

    function restoreCountryViewport() {
      const countryFeature = countryByCode.get(activeCountryCode) || null;
      fitToCountry(countryFeature, { cities: activeCities });
    }

    function clearRoute({ restoreCountry = false } = {}) {
      if (routeRequestController) {
        routeRequestController.abort();
        routeRequestController = null;
      }

      if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
      if (map.getLayer(ROUTE_CASING_LAYER_ID)) map.removeLayer(ROUTE_CASING_LAYER_ID);
      if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);

      if (currentLocationMarker) {
        currentLocationMarker.remove();
        currentLocationMarker = null;
      }

      activeRouteDestination = null;
      routePanel.hidden = true;
      routePanel.classList.remove('route-error');

      if (restoreCountry) restoreCountryViewport();
    }

    function drawRoute(coordinates) {
      if (!coordinates?.length) {
        throw new Error('Маршрут не содержит геометрию');
      }

      if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
      if (map.getLayer(ROUTE_CASING_LAYER_ID)) map.removeLayer(ROUTE_CASING_LAYER_ID);
      if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);

      map.addSource(ROUTE_SOURCE_ID, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates
          }
        }
      });

      // Оставляем подписи дорог/городов над маршрутом.
      const firstSymbolLayerId = map.getStyle().layers?.find(layer => layer.type === 'symbol')?.id;

      map.addLayer({
        id: ROUTE_CASING_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': 'rgba(255,255,255,.96)',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            4, 7,
            8, 9,
            12, 12
          ],
          'line-opacity': .96
        }
      }, firstSymbolLayerId);

      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#2563eb',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            4, 4,
            8, 5.5,
            12, 7
          ],
          'line-opacity': .92
        }
      }, firstSymbolLayerId);
    }

    function showCurrentLocation(lng, lat, accuracy) {
      if (currentLocationMarker) currentLocationMarker.remove();

      const el = document.createElement('div');
      el.className = 'current-location-marker';
      el.title = Number.isFinite(accuracy)
        ? `Текущее местоположение · точность ±${Math.round(accuracy)} м`
        : 'Текущее местоположение';

      currentLocationMarker = new maplibregl.Marker({
        element: el,
        anchor: 'center'
      })
        .setLngLat([lng, lat])
        .addTo(map);
    }

    function fitRouteIntoViewport(coordinates) {
      const routeBounds = boundsFromPoints(coordinates);
      if (!routeBounds) return;

      const bounds = [
        [routeBounds.west, routeBounds.south],
        [routeBounds.east, routeBounds.north]
      ];
      const padding = isMobileViewport()
        ? { top: 92, right: 28, bottom: 135, left: 28 }
        : { top: 80, right: 70, bottom: 110, left: 270 };

      // Маршрут может начинаться за пределами выбранной страны. На время его
      // просмотра снимаем страновые ограничения и разрешаем отдалиться ровно
      // настолько, чтобы вся линия поместилась в доступной области карты.
      map.setMinZoom(-1);
      map.setMaxBounds(null);

      const camera = map.cameraForBounds(bounds, { padding, maxZoom: 11 });
      const routeMinZoom = Math.max(-1, Math.min(10.5, (camera?.zoom ?? 3) - 0.35));

      map.fitBounds(bounds, {
        padding,
        maxZoom: 11,
        duration: 750,
        essential: true
      });
      map.setMinZoom(routeMinZoom);
    }

    function getCurrentPosition() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Геолокация не поддерживается этим браузером'));
          return;
        }

        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 30000
        });
      });
    }

    function geolocationErrorMessage(error) {
      if (!window.isSecureContext) {
        return 'Браузер блокирует геолокацию на небезопасной странице. Откройте карту через http://localhost:3000.';
      }

      if (error?.code === 1) return 'Нет доступа к геопозиции. Разрешите доступ к местоположению для этой страницы.';
      if (error?.code === 2) return 'Не удалось определить текущее местоположение.';
      if (error?.code === 3) return 'Определение местоположения заняло слишком много времени. Попробуйте ещё раз.';

      return error?.message || 'Не удалось определить текущее местоположение.';
    }

    async function requestValhallaRoute(origin, destination, signal) {
      const payload = {
        locations: [
          { lat: origin.lat, lon: origin.lng },
          { lat: destination.lat, lon: destination.lng }
        ],
        costing: 'auto',
        units: 'kilometers',
        directions_options: { units: 'kilometers' }
      };

      // GET не создаёт CORS preflight и удобен для локальной статической страницы.
      const url = `${VALHALLA_ROUTE_URL}?json=${encodeURIComponent(JSON.stringify(payload))}`;
      const response = await fetch(url, { signal });

      if (!response.ok) {
        throw new Error(`Valhalla: HTTP ${response.status}`);
      }

      const data = await response.json();
      const shape = data?.trip?.legs?.[0]?.shape;
      const summary = data?.trip?.summary;

      if (!shape || !summary) {
        throw new Error('Valhalla не вернул маршрут');
      }

      return {
        coordinates: decodePolyline6(shape),
        distanceKm: Number(summary.length),
        durationSec: Number(summary.time),
        provider: 'OpenStreetMap · Valhalla'
      };
    }

    async function requestOsrmRoute(origin, destination, signal) {
      const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
      const url = `${OSRM_ROUTE_URL}/${coordinates}?overview=full&geometries=geojson&steps=false`;
      const response = await fetch(url, { signal });

      if (!response.ok) {
        throw new Error(`OSRM: HTTP ${response.status}`);
      }

      const data = await response.json();
      const route = data?.routes?.[0];

      if (data?.code !== 'Ok' || !route?.geometry?.coordinates?.length) {
        throw new Error(data?.message || 'OSRM не вернул маршрут');
      }

      return {
        coordinates: route.geometry.coordinates,
        distanceKm: Number(route.distance) / 1000,
        durationSec: Number(route.duration),
        provider: 'OpenStreetMap · OSRM'
      };
    }

    async function requestDrivingRoute(origin, destination, signal) {
      try {
        return await requestValhallaRoute(origin, destination, signal);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('Valhalla route failed, using OSRM fallback:', error);
        return requestOsrmRoute(origin, destination, signal);
      }
    }

    async function buildRouteToCity(city) {
      closePopup();
      setInfoExpanded(false);

      // При новом запросе убираем предыдущий маршрут, чтобы при ошибке
      // не оставить на карте старую линию с уже новым названием города.
      clearRoute();
      activeRouteDestination = city;

      routeRequestController = new AbortController();
      const { signal } = routeRequestController;

      setRoutePanel({
        destination: city.name,
        status: 'Определяю текущее местоположение…'
      });

      try {
        const position = await getCurrentPosition();
        if (signal.aborted) return;

        const origin = {
          lng: position.coords.longitude,
          lat: position.coords.latitude
        };

        showCurrentLocation(origin.lng, origin.lat, position.coords.accuracy);
        setRoutePanel({
          destination: city.name,
          status: 'Строю автомобильный маршрут…'
        });

        const result = await requestDrivingRoute(
          origin,
          { lng: city.lng, lat: city.lat },
          signal
        );

        if (signal.aborted || activeRouteDestination !== city) return;

        drawRoute(result.coordinates);
        fitRouteIntoViewport(result.coordinates);

        setRoutePanel({
          destination: city.name,
          status: `${formatRouteDistance(result.distanceKm)} · ${formatRouteDuration(result.durationSec)}`,
          provider: result.provider
        });
      } catch (error) {
        if (error?.name === 'AbortError') return;

        console.error('Route error:', error);
        const isGeoError = typeof error?.code === 'number';
        setRoutePanel({
          destination: city.name,
          status: isGeoError
            ? geolocationErrorMessage(error)
            : 'Не удалось построить маршрут. Проверьте интернет и попробуйте ещё раз.',
          error: true
        });
      } finally {
        if (routeRequestController?.signal === signal) {
          routeRequestController = null;
        }
      }
    }

    routeClose.addEventListener('click', event => {
      event.stopPropagation();
      clearRoute({ restoreCountry: true });
    });

    function isMobileViewport() {
      return window.matchMedia('(max-width: 680px)').matches;
    }

    function focusCityAboveSheet(city) {
      if (!isMobileViewport() || citySheet.hidden) return;

      setInfoExpanded(false);
      const mapRect = mapContainer.getBoundingClientRect();
      const controlsRect = controlsPanel.getBoundingClientRect();
      const sheetRect = citySheet.getBoundingClientRect();
      const visibleTop = Math.max(12, controlsRect.bottom - mapRect.top + 12);
      const visibleBottom = Math.max(visibleTop, sheetRect.top - mapRect.top - 12);
      const targetMarkerY = (visibleTop + visibleBottom) / 2;
      const targetZoom = Math.max(map.getZoom(), 5.4);

      map.easeTo({
        center: [city.lng, city.lat],
        zoom: targetZoom,
        offset: [0, targetMarkerY - mapContainer.clientHeight / 2],
        duration: 420,
        essential: true
      });
    }

    function bindPopupActions(root, city) {
      const routeButton = root?.querySelector('.route-button');
      routeButton?.addEventListener('click', event => {
        event.stopPropagation();
        buildRouteToCity(city);
      });
    }

    function openCitySheet(city, monthIndex) {
      activeCity = city;
      setInfoExpanded(false);
      closeCountryDropdown();

      citySheetContent.innerHTML = popupHtml(city, monthIndex);
      citySheet.setAttribute('aria-label', `Информация о городе ${city.name}`);
      citySheet.hidden = false;
      bindPopupActions(citySheetContent, city);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => focusCityAboveSheet(city));
      });
    }

    function openDesktopPopup(city, monthIndex) {
      activeCity = city;

      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        offset: 18,
        maxWidth: '320px'
      })
        .setLngLat([city.lng, city.lat])
        .setHTML(popupHtml(city, monthIndex))
        .addTo(map);

      activePopup = popup;
      popup.on('close', () => {
        if (activePopup === popup) {
          activePopup = null;
          activeCity = null;
        }
      });

      bindPopupActions(popup.getElement(), city);
    }

    function openCityCard(city, monthIndex) {
      closePopup();

      if (isMobileViewport()) {
        openCitySheet(city, monthIndex);
      } else {
        openDesktopPopup(city, monthIndex);
      }
    }

    function renderMarkers() {
      const monthIndex = Number(monthSelect.value);

      // Удаляем старые маркеры.
      markers.forEach(marker => marker.remove());
      markers.length = 0;
      closePopup();

      activeCities.forEach(city => {
        const el = createMarkerElement(city, monthIndex);

        const marker = new maplibregl.Marker({
          element: el,
          anchor: 'bottom'
        })
          .setLngLat([city.lng, city.lat])
          .addTo(map);

        el.addEventListener('click', event => {
          event.stopPropagation();
          openCityCard(city, monthIndex);
        });

        markers.push(marker);
      });

      updateZoomDensity();
    }

    // На дальнем масштабе уменьшаем маркеры, чтобы карта не превращалась в облако лейблов.
    function updateZoomDensity() {
      const threshold = window.innerWidth <= 680 ? 5.8 : 5.15;
      mapContainer.classList.toggle('map-overview', map.getZoom() < threshold);
    }

    map.on('zoom', updateZoomDensity);

    let previousMobileLayout = isMobileViewport();
    window.addEventListener('resize', () => {
      const mobileLayout = isMobileViewport();
      const city = activeCity;

      if (city && mobileLayout !== previousMobileLayout) {
        openCityCard(city, Number(monthSelect.value));
      } else if (city && mobileLayout) {
        requestAnimationFrame(() => focusCityAboveSheet(city));
      }

      previousMobileLayout = mobileLayout;
    });


    // Тап по карте закрывает popup.
    map.on('click', () => {
      closePopup();
      closeCountryDropdown();
      setInfoExpanded(false);
    });

    // Фильтр месяца обновляет температуры без перезагрузки карты.
    monthSelect.addEventListener('change', renderMarkers);

    map.on('load', async () => {
      // Начальные данные читаем из того же локального JSON, что и другие страны.
      try {
        const result = await initialClimate;
        if (result.error) throw result.error;
        const kazakhstan = result.value;
        activeCountryName = kazakhstan.countryName || activeCountryName;
        activeCities = kazakhstan.cities;
      } catch (error) {
        console.error('Country climate JSON load failed:', error);
        activeCities = [];
        setCountryStatus(
          'Не удалось загрузить data/climate/KAZ.json. Проверьте полноту публикации сайта.',
          { error: true },
        );
      }

      updateInfoPanel();
      renderMarkers();

      // Казахстан остаётся стартовой страной и использует исходный framing.
      map.fitBounds(
        [[46.2, 40.2], [87.5, 55.6]],
        {
          padding: {
            top: window.innerWidth <= 680 ? 80 : 70,
            right: 45,
            bottom: 45,
            left: window.innerWidth <= 680 ? 35 : 230
          },
          duration: 700
        }
      );

      loading.classList.add('hidden');
      setTimeout(() => loading.remove(), 350);

      // География мира догружается в фоне; климат для стран читается из ./data/climate/*.json.
      loadGlobalGeography().catch(error => {
        console.error('Global geography load failed:', error);
        setCountryPickerDisabled(true);
        setCountryStatus(
          'Не удалось загрузить список стран. Казахстан продолжает работать в локальном режиме.',
          { error: true }
        );
      });
    });

    map.on('error', event => {
      console.error('Map error:', event?.error || event);

      if (!map.loaded()) {
        loadingText.textContent =
          'Не удалось загрузить векторную подложку. Проверьте интернет-соединение. ' +
          'API-ключ для этой карты не нужен.';
      }
    });

    // MapLibre сам поддерживает:
    // - pinch-to-zoom двумя пальцами;
    // - pan одним пальцем;
    // - kinetic scrolling;
    // - scroll zoom мышью;
    // - double tap / double click zoom.
