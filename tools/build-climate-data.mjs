import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, access, open, unlink, readdir } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'data', 'climate');
const COUNTRY_PATCH_DIR = join(ROOT, 'patches', 'countries');
const CACHE_DIR = join(ROOT, '.cache', 'climate-build');

const PERIOD = '1991–2020';
// Число городов теперь зависит от масштаба страны и количества доступных точек.
// Для крупных стран фиксированные 20 точек давали слишком разреженную карту.
const CITY_LIMITS = {
  tiny: 14,
  small: 20,
  medium: 35,
  large: 55,
  huge: 80,
};
const MAX_WMO_DISTANCE_KM = 80;

// География нужна только на этапе сборки. В браузере климатические API не вызываются.
const NATURAL_EARTH_COUNTRIES_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_admin_0_countries.geojson';
const NATURAL_EARTH_CITIES_URL =
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_populated_places_simple.geojson';

// WMO Climatological Standard Normals 1991–2020, composite tables with >=24 years.
const NOAA_WMO_BASE =
  'https://www.nodc.noaa.gov/archive/arc0216/0253808/6.6/data/0-data/data-composite-primary-parameters-min24';
const WMO_FILES = {
  mean: `${NOAA_WMO_BASE}/wmo_normals_9120_TAVG_min24.csv`,
  min: `${NOAA_WMO_BASE}/wmo_normals_9120_TMIN_min24.csv`,
  max: `${NOAA_WMO_BASE}/wmo_normals_9120_TMAX_min24.csv`,
};
const WMO_SOURCE_URL = 'https://www.ncei.noaa.gov/products/wmo-climate-normals';

// CRU TS 4.09 0.5° — fallback для городов без подходящей WMO-станции.
// Используем официальные ASCII .dat.gz, а не NetCDF. Это намеренно:
// netcdfjs читает только NetCDF v3, тогда как файлы CCKP могут быть NetCDF4/HDF5.
const CRU_SOURCE_URL = 'https://crudata.uea.ac.uk/cru/data/hrg/cru_ts_4.09/';
const CRU_BASE_URL =
  'https://crudata.uea.ac.uk/cru/data/hrg/cru_ts_4.09/cruts.2503051245.v4.09';
const CRU_PERIODS = ['1991.2000', '2001.2010', '2011.2020'];
const CRU_GRID_ROWS = 360;
const CRU_GRID_COLS = 720;
const CRU_CELL_SIZE = 0.5;
const CRU_FIRST_LAT = -89.75;
const CRU_FIRST_LON = -179.75;
const CRU_SEARCH_RADIUS = 2;
const MIN_VALID_CLIMATE_TEMP = -90;
const MAX_VALID_CLIMATE_TEMP = 60;
const MIN_VALID_ELEVATION = -500;
const MAX_VALID_ELEVATION = 9000;

function cruAsciiUrl(variable, period) {
  return `${CRU_BASE_URL}/${variable}/cru_ts4.09.${period}.${variable}.dat.gz`;
}

const getProperty = (properties, ...names) => {
  for (const name of names) {
    const value = properties?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const getCountryCode = feature => {
  const code = String(
    getProperty(feature?.properties, 'ADM0_A3', 'adm0_a3', 'SOV_A3', 'sov_a3') || '',
  );
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

const getCountryDisplayName = feature =>
  String(
    getProperty(
      feature?.properties,
      'NAME_RU',
      'name_ru',
      'NAME_LONG',
      'ADMIN',
      'NAME',
      'admin',
      'name',
    ) || getCountryCode(feature) || 'Страна',
  );

const getPlaceName = feature =>
  String(
    getProperty(feature?.properties, 'namepar', 'name', 'NAME', 'nameascii', 'NAMEASCII') ||
      'Город',
  );

const round1 = value => Math.round(Number(value) * 10) / 10;

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows;
}

function parseClimateNumber(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const number = Number(text);
  // В таблицах WMO -99.9 означает отсутствие месячной нормы. Более широкий
  // разумный диапазон заодно не пропускает другие служебные значения источника.
  return Number.isFinite(number) &&
    number > MIN_VALID_CLIMATE_TEMP &&
    number < MAX_VALID_CLIMATE_TEMP
    ? round1(number)
    : null;
}

function parseElevation(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const number = Number(text);
  return Number.isFinite(number) &&
    number >= MIN_VALID_ELEVATION &&
    number <= MAX_VALID_ELEVATION
    ? number
    : null;
}

function complete12(values) {
  return Array.isArray(values) && values.length === 12 && values.every(Number.isFinite);
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasGzipMagic(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await file.read(header, 0, 2, 0);
    return bytesRead === 2 && header[0] === 0x1f && header[1] === 0x8b;
  } finally {
    await file.close();
  }
}

async function downloadCached(url, filename, binary = false, validator = null) {
  const path = join(CACHE_DIR, filename);

  // Старый/битый кэш не должен ломать последующие запуски сборщика.
  if ((await exists(path)) && validator && !(await validator(path))) {
    console.warn(`! invalid cache ${filename}, скачиваю заново`);
    await unlink(path);
  }

  if (!(await exists(path))) {
    console.log(`↓ ${filename}`);
    const response = await fetch(url, {
      headers: { 'user-agent': 'climate-map-static-builder/1.1' },
    });
    if (!response.ok) throw new Error(`${filename}: HTTP ${response.status} (${url})`);

    const data = binary
      ? Buffer.from(await response.arrayBuffer())
      : Buffer.from(await response.text(), 'utf8');
    await writeFile(path, data);

    if (validator && !(await validator(path))) {
      await unlink(path).catch(() => {});
      throw new Error(
        `${filename}: сервер вернул файл неожиданного формата. ` +
        `Проверь URL/доступ к источнику: ${url}`,
      );
    }
  } else {
    console.log(`✓ cache ${filename}`);
  }
  return path;
}

async function readJsonUrl(url, filename) {
  const path = await downloadCached(url, filename);
  return JSON.parse(await readFile(path, 'utf8'));
}

function buildCountryNameIndex(countryFeatures) {
  const index = new Map();
  const propertyNames = [
    'ADMIN', 'NAME', 'NAME_LONG', 'FORMAL_EN', 'SOVEREIGNT', 'BRK_NAME',
    'NAME_EN', 'NAME_CIAWF', 'ABBREV',
  ];

  for (const feature of countryFeatures) {
    const code = getCountryCode(feature);
    if (!code) continue;
    for (const property of propertyNames) {
      const value = feature.properties?.[property];
      const normalized = normalizeName(value);
      if (normalized && !index.has(normalized)) index.set(normalized, code);
    }
  }

  // Частые официальные варианты названий в международных наборах.
  const aliases = {
    'united states of america': 'USA',
    'united states': 'USA',
    'russian federation': 'RUS',
    'viet nam': 'VNM',
    'iran islamic republic of': 'IRN',
    'iran': 'IRN',
    'bolivia plurinational state of': 'BOL',
    'venezuela bolivarian republic of': 'VEN',
    'tanzania united republic of': 'TZA',
    'syrian arab republic': 'SYR',
    'lao people s democratic republic': 'LAO',
    'moldova republic of': 'MDA',
    'korea republic of': 'KOR',
    'republic of korea': 'KOR',
    'korea democratic people s republic of': 'PRK',
    'cote d ivoire': 'CIV',
    'czech republic': 'CZE',
    'czechia': 'CZE',
    'brunei darussalam': 'BRN',
    'micronesia federated states of': 'FSM',
    'north macedonia': 'MKD',
    'eswatini': 'SWZ',
    'swaziland': 'SWZ',
    'cape verde': 'CPV',
    'cabo verde': 'CPV',
    'the bahamas': 'BHS',
    'bahamas': 'BHS',
    'the gambia': 'GMB',
    'gambia': 'GMB',
  };
  for (const [name, code] of Object.entries(aliases)) index.set(name, code);
  return index;
}

function parseWmoTable(text, kind, countryNameIndex) {
  const rows = parseCsv(text);
  const data = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length < 21) continue;

    const lat = Number(row[4]);
    const lng = Number(row[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const months = row.slice(9, 21).map(parseClimateNumber);
    const id = String(row[2] || '').trim();
    const wigosId = String(row[3] || '').trim();
    const country = String(row[7] || '').trim();
    const station = String(row[8] || '').trim();

    data.push({
      key: wigosId || id || `${lat}|${lng}|${station}`,
      id,
      wigosId,
      lat,
      lng,
      elevation: parseElevation(row[6]),
      country,
      countryCode: countryNameIndex.get(normalizeName(country)) || null,
      station,
      [kind]: months,
    });
  }

  return data;
}

function mergeWmoStations(tables) {
  const stations = new Map();
  for (const [kind, rows] of Object.entries(tables)) {
    for (const item of rows) {
      const previous = stations.get(item.key) || {
        key: item.key,
        id: item.id,
        wigosId: item.wigosId,
        lat: item.lat,
        lng: item.lng,
        elevation: item.elevation,
        country: item.country,
        countryCode: item.countryCode,
        station: item.station,
      };
      previous[kind] = item[kind];
      stations.set(item.key, previous);
    }
  }

  return [...stations.values()].filter(station => {
    if (!complete12(station.mean) || !complete12(station.min) || !complete12(station.max)) {
      return false;
    }

    // Некорректные строки встречаются и без явного sentinel: например, когда
    // TAVG ниже TMIN. Не используем такую станцию — город получит CRU fallback.
    return station.mean.every(
      (mean, month) => station.min[month] <= mean && mean <= station.max[month],
    );
  });
}

function scorePlace(feature) {
  const p = feature.properties || {};
  const capital = Number(getProperty(p, 'adm0cap', 'ADM0CAP') || 0) ? 10_000_000_000 : 0;
  const worldCity = Number(getProperty(p, 'worldcity', 'WORLDCITY') || 0) ? 1_000_000_000 : 0;
  const admin1 = String(getProperty(p, 'featurecla', 'FEATURECLA') || '').includes('Admin-1')
    ? 100_000_000
    : 0;
  const population = Number(getProperty(p, 'pop_max', 'POP_MAX') || 0);
  return capital + worldCity + admin1 + population;
}

function patchPlaceFeature(countryCode, place, defaultSource = null) {
  const lat = Number(place?.lat);
  const lng = Number(place?.lng);
  const elevation = place?.elevation == null ? null : Number(place.elevation);
  const source = place?.source || defaultSource;
  const sourceId = place?.sourceId == null ? null : String(place.sourceId);
  const sourceUrl = source?.url || (
    sourceId && source?.recordUrlTemplate
      ? source.recordUrlTemplate.replace('{id}', encodeURIComponent(sourceId))
      : null
  );
  if (!place?.name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`${countryCode}: у города в патче обязательны name, lat и lng`);
  }

  return {
    type: 'Feature',
    properties: {
      adm0_a3: countryCode,
      name: place.name,
      namepar: place.name,
      pop_max: Number(place.population) || 0,
      location_elevation: Number.isFinite(elevation) ? elevation : null,
      featurecla: place.admin1 ? 'Admin-1 capital' : 'Populated place',
      location_source: source?.name || null,
      location_source_id: sourceId,
      location_source_url: sourceUrl,
      location_dataset_url: source?.datasetUrl || null,
    },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  };
}

function buildPlacesByCountry(features, countryPatches = new Map()) {
  const byCountry = new Map();
  for (const feature of features) {
    const code = String(
      getProperty(feature?.properties, 'adm0_a3', 'ADM0_A3', 'sov_a3', 'SOV_A3') || '',
    );
    if (!/^[A-Z]{3}$/.test(code)) continue;
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code).push(feature);
  }

  for (const [code, patch] of countryPatches) {
    const patchedFeatures = (patch.places || []).map(
      place => patchPlaceFeature(code, place, patch.placeSource),
    );
    if (patch.placeStrategy === 'replace') {
      byCountry.set(code, patchedFeatures);
      continue;
    }

    // merge работает как upsert: совпавший по имени город из патча заменяет
    // исходную точку Natural Earth, новые названия просто добавляются.
    const patchedNames = new Set(
      patchedFeatures.map(feature => normalizeName(getPlaceName(feature))),
    );
    const baseFeatures = (byCountry.get(code) || []).filter(
      feature => !patchedNames.has(normalizeName(getPlaceName(feature))),
    );
    byCountry.set(code, [...baseFeatures, ...patchedFeatures]);
  }

  return byCountry;
}

function countryCityLimit(countryFeature, availableCount, patch) {
  if (Number.isInteger(patch?.cityLimit) && patch.cityLimit > 0) return patch.cityLimit;

  const population = Number(
    getProperty(countryFeature?.properties, 'POP_EST', 'pop_est', 'POPULATION', 'population') || 0,
  );

  // availableCount хорошо отражает как размер страны, так и детализацию Natural Earth.
  // Население добавляем как второй сигнал, чтобы густонаселённые страны не обрезались слишком сильно.
  if (availableCount >= 150 || population >= 120_000_000) return CITY_LIMITS.huge;
  if (availableCount >= 95 || population >= 60_000_000) return CITY_LIMITS.large;
  if (availableCount >= 55 || population >= 25_000_000) return CITY_LIMITS.medium;
  if (availableCount >= 25 || population >= 8_000_000) return CITY_LIMITS.small;
  return CITY_LIMITS.tiny;
}

function placePoint(feature) {
  const coords = feature?.geometry?.coordinates;
  return {
    lng: Number(coords?.[0]),
    lat: Number(coords?.[1]),
  };
}

function minDistanceToSelected(feature, selected) {
  if (!selected.length) return Infinity;
  const point = placePoint(feature);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return -Infinity;

  let minDistance = Infinity;
  for (const selectedFeature of selected) {
    const selectedPoint = placePoint(selectedFeature);
    const distance = haversineKm(
      point.lat,
      point.lng,
      selectedPoint.lat,
      selectedPoint.lng,
    );
    if (distance < minDistance) minDistance = distance;
  }
  return minDistance;
}

function selectGeographicallyBalancedPlaces(features, limit) {
  if (features.length <= limit) {
    return [...features].sort((a, b) => scorePlace(b) - scorePlace(a));
  }

  const ranked = [...features].sort((a, b) => scorePlace(b) - scorePlace(a));

  // Около 40% — крупнейшие/столичные/региональные центры.
  // Остальные точки добираются по максимальному расстоянию до уже выбранных,
  // чтобы Россия не схлопывалась в европейскую часть, а США — в восточное побережье.
  const priorityCount = Math.max(8, Math.min(limit, Math.round(limit * 0.4)));
  const selected = ranked.slice(0, priorityCount);
  const remaining = ranked.slice(priorityCount);

  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const feature = remaining[index];
      const distanceKm = minDistanceToSelected(feature, selected);
      const population = Number(getProperty(feature.properties, 'pop_max', 'POP_MAX') || 0);

      // География — главный фактор, население лишь слегка разрешает ничьи.
      const candidateScore = distanceKm + Math.log10(Math.max(1, population)) * 4;
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestIndex = index;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function chooseCountryPlaces(countryCode, countryFeature, placesByCountry, patch) {
  const features = placesByCountry.get(countryCode) || [];
  const unique = new Map();

  for (const feature of features) {
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const name = getPlaceName(feature);
    const key = `${normalizeName(name)}|${Number(coords[0]).toFixed(2)}|${Number(coords[1]).toFixed(2)}`;
    if (!unique.has(key)) unique.set(key, feature);
  }

  const available = [...unique.values()];
  const limit = countryCityLimit(countryFeature, available.length, patch);
  const selected = selectGeographicallyBalancedPlaces(available, limit)
    .map(feature => {
      const locationElevationValue = getProperty(feature.properties, 'location_elevation');
      const locationElevation = locationElevationValue == null
        ? null
        : Number(locationElevationValue);
      const locationSourceName = getProperty(feature.properties, 'location_source');
      const locationSourceId = getProperty(feature.properties, 'location_source_id');
      const locationSourceUrl = getProperty(feature.properties, 'location_source_url');
      const locationDatasetUrl = getProperty(feature.properties, 'location_dataset_url');
      return {
        name: getPlaceName(feature),
        lng: Number(feature.geometry.coordinates[0]),
        lat: Number(feature.geometry.coordinates[1]),
        population: Number(getProperty(feature.properties, 'pop_max', 'POP_MAX') || 0) || null,
        // Нужен только для возможного declutter на клиенте; на климатические расчёты не влияет.
        displayPriority: scorePlace(feature),
        ...(Number.isFinite(locationElevation) ? { locationElevation } : {}),
        ...(locationSourceName ? {
          locationSource: {
            name: locationSourceName,
            id: locationSourceId,
            url: locationSourceUrl,
            datasetUrl: locationDatasetUrl,
          },
        } : {}),
      };
    });

  if (selected.length) return selected;

  // Для очень маленьких территорий Natural Earth может не содержать populated place.
  // Тогда сохраняем одну репрезентативную точку, чтобы JSON всё равно был пригоден для карты.
  const lng = Number(getProperty(countryFeature.properties, 'LABEL_X', 'label_x'));
  const lat = Number(getProperty(countryFeature.properties, 'LABEL_Y', 'label_y'));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return [{
      name: getCountryDisplayName(countryFeature),
      lat,
      lng,
      population: null,
      representativePoint: true,
      displayPriority: 0,
    }];
  }

  return [];
}

function deg2rad(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = deg2rad(bLat - aLat);
  const dLng = deg2rad(bLng - aLng);
  const lat1 = deg2rad(aLat);
  const lat2 = deg2rad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestWmoStation(city, countryCode, stationsByCountry, allStations) {
  const preferred = stationsByCountry.get(countryCode) || [];
  // Если WMO-название страны не сопоставилось, допускаем только совсем близкую станцию.
  const candidates = preferred.length ? preferred : allStations;
  const maxDistance = preferred.length ? MAX_WMO_DISTANCE_KM : 35;
  let best = null;

  for (const station of candidates) {
    if (Math.abs(station.lat - city.lat) > 1.5) continue;
    const lonScale = Math.max(0.2, Math.cos(deg2rad(city.lat)));
    if (Math.abs(station.lng - city.lng) * lonScale > 1.5) continue;
    const distanceKm = haversineKm(city.lat, city.lng, station.lat, station.lng);
    if (distanceKm > maxDistance) continue;
    if (
      Number.isFinite(city.locationElevation) &&
      Number.isFinite(station.elevation) &&
      Math.abs(city.locationElevation - station.elevation) > 400
    ) continue;
    if (!best || distanceKm < best.distanceKm) best = { station, distanceKm };
  }

  return best;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapColumn(value) {
  return ((value % CRU_GRID_COLS) + CRU_GRID_COLS) % CRU_GRID_COLS;
}

function cruCellKey(row, col) {
  return `${row}:${col}`;
}

// CRU ASCII: 720 столбцов × 360 строк, первая ячейка — 89.75°S, 179.75°W.
// Для прибрежных городов берём несколько соседних ячеек и позже выбираем
// ближайшую, где есть полные 12 месячных норм.
function cruCandidateCells(city) {
  const baseRow = clamp(
    Math.round((city.lat - CRU_FIRST_LAT) / CRU_CELL_SIZE),
    0,
    CRU_GRID_ROWS - 1,
  );
  const baseCol = wrapColumn(
    Math.round((city.lng - CRU_FIRST_LON) / CRU_CELL_SIZE),
  );
  const candidates = [];

  for (let radius = 0; radius <= CRU_SEARCH_RADIUS; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (radius && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const row = baseRow + dy;
        if (row < 0 || row >= CRU_GRID_ROWS) continue;
        const col = wrapColumn(baseCol + dx);
        const lat = CRU_FIRST_LAT + row * CRU_CELL_SIZE;
        const lng = CRU_FIRST_LON + col * CRU_CELL_SIZE;
        candidates.push({
          row,
          col,
          key: cruCellKey(row, col),
          distanceKm: haversineKm(city.lat, city.lng, lat, lng),
        });
      }
    }
  }

  return candidates.sort((a, b) => a.distanceKm - b.distanceKm);
}

function parseCruGridLine(line) {
  // ASCII CRU — integer-only grid (температуры ×10), missing = -999.
  // Regex работает и для whitespace-separated, и для fixed-width Fortran полей.
  const values = line.match(/-?\d+/g);
  if (!values || values.length < CRU_GRID_COLS) {
    throw new Error(`Некорректная строка CRU: ожидалось ${CRU_GRID_COLS} значений, получено ${values?.length || 0}`);
  }
  return values;
}

function buildRowsIndex(requiredCellKeys) {
  const rows = new Map();
  for (const key of requiredCellKeys) {
    const [rowText, colText] = key.split(':');
    const row = Number(rowText);
    const col = Number(colText);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ key, col });
  }
  return rows;
}

async function accumulateCruAscii(path, requiredCellKeys, accumulators) {
  const rowsIndex = buildRowsIndex(requiredCellKeys);
  const input = createReadStream(path).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineIndex = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = lineIndex % CRU_GRID_ROWS;
    const timestep = Math.floor(lineIndex / CRU_GRID_ROWS);
    const month = timestep % 12;
    const cells = rowsIndex.get(row);

    if (cells?.length) {
      const values = parseCruGridLine(line);
      for (const { key, col } of cells) {
        const raw = Number(values[col]);
        if (!Number.isFinite(raw) || raw === -999) continue;
        const bucket = accumulators.get(key);
        bucket.sum[month] += raw / 10;
        bucket.count[month] += 1;
      }
    }

    lineIndex += 1;
  }

  const expectedLines = 10 * 12 * CRU_GRID_ROWS;
  if (lineIndex !== expectedLines) {
    throw new Error(
      `${path}: неожиданное число строк CRU (${lineIndex}, ожидалось ${expectedLines})`,
    );
  }
}

async function loadCruAsciiNormals(variable, requiredCellKeys) {
  const keys = [...requiredCellKeys];
  const accumulators = new Map(
    keys.map(key => [key, { sum: Array(12).fill(0), count: Array(12).fill(0) }]),
  );

  for (const period of CRU_PERIODS) {
    const filename = `cru-ts4.09-${period}-${variable}.dat.gz`;
    const path = await downloadCached(
      cruAsciiUrl(variable, period),
      filename,
      true,
      hasGzipMagic,
    );
    await accumulateCruAscii(path, requiredCellKeys, accumulators);
  }

  const result = new Map();
  for (const [key, bucket] of accumulators) {
    result.set(
      key,
      bucket.count.map((count, month) => (count ? round1(bucket.sum[month] / count) : null)),
    );
  }
  return result;
}

function cruCityFromNormals(city, countryCode, meanValues, minValues, maxValues, cell) {
  return {
    ...city,
    countryCode,
    alt: null,
    temps: meanValues,
    avgLow: minValues || Array(12).fill(null),
    avgHigh: maxValues || Array(12).fill(null),
    temperaturePeriod: PERIOD,
    climateSource: 'cru',
    sourceGridCell: {
      lat: round1(CRU_FIRST_LAT + cell.row * CRU_CELL_SIZE),
      lng: round1(CRU_FIRST_LON + cell.col * CRU_CELL_SIZE),
      distanceKm: round1(cell.distanceKm),
    },
    meanSourceUrl: CRU_SOURCE_URL,
    meanSourceName: 'CRU TS 4.09 · климатология 1991–2020 · сетка 0.5°',
    meanSourceTier: 'cru',
    rangeSourceUrl: CRU_SOURCE_URL,
    rangeSourceName: 'CRU TS 4.09 · средний минимум / максимум · 1991–2020',
    rangeSourceTier: 'cru',
  };
}

function wmoCity(city, countryCode, match) {
  const { station, distanceKm } = match;
  return {
    ...city,
    countryCode,
    alt: station.elevation,
    temps: station.mean,
    avgLow: station.min,
    avgHigh: station.max,
    temperaturePeriod: PERIOD,
    climateSource: 'wmo',
    sourceStation: {
      name: station.station,
      id: station.id || null,
      wigosId: station.wigosId || null,
      country: station.country || null,
      lat: station.lat,
      lng: station.lng,
      distanceKm: round1(distanceKm),
    },
    meanSourceUrl: WMO_SOURCE_URL,
    meanSourceName: `WMO 1991–2020 · ${station.station}`,
    meanSourceTier: 'wmo',
    rangeSourceUrl: WMO_SOURCE_URL,
    rangeSourceName: `WMO 1991–2020 · TMIN/TMAX · ${station.station}`,
    rangeSourceTier: 'wmo',
  };
}

async function loadCountryPatches() {
  if (!(await exists(COUNTRY_PATCH_DIR))) return new Map();

  const patches = new Map();
  const filenames = (await readdir(COUNTRY_PATCH_DIR))
    .filter(name => /^[A-Z]{3}\.json$/.test(name))
    .sort();

  for (const filename of filenames) {
    const code = filename.slice(0, 3);
    const patch = JSON.parse(await readFile(join(COUNTRY_PATCH_DIR, filename), 'utf8'));
    if (patch.countryCode !== code) {
      throw new Error(`${filename}: countryCode должен совпадать с именем файла`);
    }
    if (!['merge', 'replace'].includes(patch.placeStrategy)) {
      throw new Error(`${filename}: placeStrategy должен быть merge или replace`);
    }
    if (!Array.isArray(patch.places)) {
      throw new Error(`${filename}: places должен быть массивом`);
    }
    patches.set(code, patch);
  }

  return patches;
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  await ensureDir(CACHE_DIR);

  console.log('Загружаю географию Natural Earth…');
  const [countries, places] = await Promise.all([
    readJsonUrl(NATURAL_EARTH_COUNTRIES_URL, 'ne-countries.geojson'),
    readJsonUrl(NATURAL_EARTH_CITIES_URL, 'ne-cities.geojson'),
  ]);

  const countryFeatures = countries.features.filter(feature => {
    const code = getCountryCode(feature);
    return code && code !== 'ATA';
  });
  const countryPatches = await loadCountryPatches();
  const placesByCountry = buildPlacesByCountry(places.features, countryPatches);
  const countryNameIndex = buildCountryNameIndex(countryFeatures);

  console.log('Загружаю WMO normals (TAVG/TMIN/TMAX)…');
  const [wmoMeanPath, wmoMinPath, wmoMaxPath] = await Promise.all([
    downloadCached(WMO_FILES.mean, 'wmo-TAVG-min24.csv'),
    downloadCached(WMO_FILES.min, 'wmo-TMIN-min24.csv'),
    downloadCached(WMO_FILES.max, 'wmo-TMAX-min24.csv'),
  ]);

  const wmoTables = {
    mean: parseWmoTable(await readFile(wmoMeanPath, 'utf8'), 'mean', countryNameIndex),
    min: parseWmoTable(await readFile(wmoMinPath, 'utf8'), 'min', countryNameIndex),
    max: parseWmoTable(await readFile(wmoMaxPath, 'utf8'), 'max', countryNameIndex),
  };
  const stations = mergeWmoStations(wmoTables);
  const stationsByCountry = new Map();
  for (const station of stations) {
    if (!station.countryCode) continue;
    if (!stationsByCountry.has(station.countryCode)) stationsByCountry.set(station.countryCode, []);
    stationsByCountry.get(station.countryCode).push(station);
  }
  console.log(`WMO complete stations: ${stations.length}`);

  // Сначала планируем все страны. Так CRU читается всего 3×3 больших ASCII-файла,
  // независимо от количества городов, а не запрашивается отдельно для каждой точки.
  const plans = [];
  const cruNeeds = [];

  for (const feature of countryFeatures) {
    const code = getCountryCode(feature);
    if (!code) continue;

    if (code === 'KAZ' && (await exists(join(OUTPUT_DIR, 'KAZ.json')))) {
      plans.push({ code, curated: true });
      continue;
    }

    const countryName = getCountryDisplayName(feature);
    const availablePlaces = (placesByCountry.get(code) || []).length;
    const baseCities = chooseCountryPlaces(
      code,
      feature,
      placesByCountry,
      countryPatches.get(code),
    );
    if (baseCities.length >= 35) {
      console.log(`• ${code} ${countryName}: выбираю ${baseCities.length} из ${availablePlaces} городских точек`);
    }
    const cityPlans = baseCities.map((city, index) => {
      const station = nearestWmoStation(city, code, stationsByCountry, stations);
      if (station) return { type: 'wmo', city, station };

      const id = `${code}:${index}`;
      const candidates = cruCandidateCells(city);
      const plan = { type: 'cru', id, city, candidates, cell: null };
      cruNeeds.push(plan);
      return plan;
    });

    plans.push({ code, countryName, cityPlans });
  }

  // TMP сначала: по нему выбираем ближайшую сухопутную CRU-ячейку.
  let cruMeanNormals = new Map();
  let cruMinNormals = new Map();
  let cruMaxNormals = new Map();

  if (cruNeeds.length) {
    console.log(`CRU fallback нужен для ${cruNeeds.length} городов.`);
    const meanCells = new Set(cruNeeds.flatMap(item => item.candidates.map(cell => cell.key)));
    console.log(`Читаю CRU TMP 1991–2020 (${meanCells.size} кандидатных ячеек)…`);
    cruMeanNormals = await loadCruAsciiNormals('tmp', meanCells);

    for (const item of cruNeeds) {
      item.cell = item.candidates.find(cell => complete12(cruMeanNormals.get(cell.key))) || null;
    }

    const selectedCells = new Set(cruNeeds.filter(item => item.cell).map(item => item.cell.key));
    console.log(`Читаю CRU TMN/TMX 1991–2020 (${selectedCells.size} выбранных ячеек)…`);
    // Читаем последовательно: на телефонах/Termux это заметно снижает пиковую память.
    cruMinNormals = await loadCruAsciiNormals('tmn', selectedCells);
    cruMaxNormals = await loadCruAsciiNormals('tmx', selectedCells);
  }

  const manifest = [];
  let generated = 0;
  let totalWmo = 0;
  let totalCru = 0;

  for (const plan of plans) {
    if (plan.curated) {
      const existing = JSON.parse(await readFile(join(OUTPUT_DIR, 'KAZ.json'), 'utf8'));
      manifest.push({
        countryCode: 'KAZ',
        countryName: existing.countryName || 'Казахстан',
        cityCount: existing.cities?.length || 0,
        source: 'curated',
      });
      continue;
    }

    const cities = [];
    let wmoCount = 0;
    let cruCount = 0;

    for (const cityPlan of plan.cityPlans) {
      if (cityPlan.type === 'wmo') {
        cities.push(wmoCity(cityPlan.city, plan.code, cityPlan.station));
        wmoCount += 1;
        continue;
      }

      if (!cityPlan.cell) {
        console.warn(`! ${plan.code} ${cityPlan.city.name}: не найдена сухопутная CRU-ячейка`);
        continue;
      }

      const key = cityPlan.cell.key;
      const mean = cruMeanNormals.get(key);
      const min = cruMinNormals.get(key);
      const max = cruMaxNormals.get(key);
      if (!complete12(mean) || !complete12(min) || !complete12(max)) {
        console.warn(`! ${plan.code} ${cityPlan.city.name}: неполные CRU TMP/TMN/TMX`);
        continue;
      }

      cities.push(
        cruCityFromNormals(cityPlan.city, plan.code, mean, min, max, cityPlan.cell),
      );
      cruCount += 1;
    }

    const payload = {
      countryCode: plan.code,
      countryName: plan.countryName,
      period: PERIOD,
      generatedFrom: {
        primary: 'WMO Climatological Standard Normals 1991–2020 (min24 composites)',
        fallback: 'CRU TS 4.09 ASCII grids, TMP/TMN/TMX averaged over 1991–2020, 0.5°',
      },
      cities,
    };

    await writeFile(
      join(OUTPUT_DIR, `${plan.code}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    manifest.push({
      countryCode: plan.code,
      countryName: plan.countryName,
      cityCount: cities.length,
      wmoCount,
      cruCount,
    });
    generated += 1;
    totalWmo += wmoCount;
    totalCru += cruCount;
    console.log(
      `${plan.code.padEnd(3)} ${plan.countryName}: ${cities.length} (WMO ${wmoCount}, CRU ${cruCount})`,
    );
  }

  manifest.sort((a, b) => a.countryCode.localeCompare(b.countryCode));
  await writeFile(
    join(OUTPUT_DIR, 'manifest.json'),
    `${JSON.stringify({ period: PERIOD, generated, totalWmo, totalCru, countries: manifest }, null, 2)}\n`,
  );

  console.log(`\nГотово: ${manifest.length} стран/территорий.`);
  console.log(`WMO city matches: ${totalWmo}; CRU fallbacks: ${totalCru}.`);
  console.log(`Файлы: ${OUTPUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('\nСборка климатических JSON завершилась с ошибкой:');
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  buildPlacesByCountry,
  complete12,
  mergeWmoStations,
  parseClimateNumber,
  parseElevation,
};
