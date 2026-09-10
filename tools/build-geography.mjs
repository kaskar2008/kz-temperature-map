import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Use the same Natural Earth snapshot as the climate build. No geometry simplification.
const source = new URL('../.cache/climate-build/ne-countries.geojson', import.meta.url);
const output = new URL('../data/geography/', import.meta.url);
const collection = JSON.parse(await readFile(source, 'utf8'));
await mkdir(output, { recursive: true });
const keys = ['ADM0_A3', 'SOV_A3', 'NAME_RU', 'NAME_LONG', 'ADMIN', 'NAME', 'NAME_EN', 'SOVEREIGNT'];
const features = [];
const seen = new Set();
for (const feature of collection.features) {
  const code = feature.properties.ADM0_A3 || feature.properties.SOV_A3;
  if (!/^[A-Z]{3}$/.test(code) || seen.has(code)) continue;
  seen.add(code);
  const properties = Object.fromEntries(keys.filter(key => feature.properties[key] != null).map(key => [key, feature.properties[key]]));
  // Per-polygon bounds keep overseas territories from making every location a candidate.
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const bounds = polygons.map(polygon => {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of polygon[0]) {
      bbox[0] = Math.min(bbox[0], lng); bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lng); bbox[3] = Math.max(bbox[3], lat);
    }
    if (polygon[0].some((point, i, ring) => i > 0 && Math.abs(point[0] - ring[i - 1][0]) > 180)) {
      bbox[0] = -180; bbox[2] = 180;
    }
    return bbox;
  });
  features.push({ type: 'Feature', properties, geometry: null, bounds });
  await writeFile(new URL(`${code}.json`, output), JSON.stringify({ type: 'Feature', properties, geometry: feature.geometry }));
}
await writeFile(new URL('index.json', output), JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`Generated index and ${features.length} country geometries (original coordinates preserved).`);
