import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const app = await read('assets/app.js');
const index = JSON.parse(await read('data/geography/index.json'));

test('geography index has complete country files, valid polygons, and conservative bounds', async () => {
  assert.equal(index.features.length, 258);
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 300000);
  for (const entry of index.features) {
    assert.equal(entry.geometry, null);
    const feature = JSON.parse(await read(`data/geography/${entry.properties.ADM0_A3}.json`));
    assert.deepEqual(feature.properties, entry.properties);
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    assert.equal(polygons.length, entry.bounds.length);
    polygons.forEach((polygon, i) => {
      const [west, south, east, north] = entry.bounds[i];
      for (const ring of polygon) {
        assert.ok(ring.length >= 4);
        assert.deepEqual(ring[0], ring.at(-1));
      }
      for (const [lng, lat] of polygon[0]) assert.ok(lng >= west && lng <= east && lat >= south && lat <= north);
    });
  }
});

test('location detection loads candidate countries only, and handles an ocean point', async () => {
  const calls = [];
  const context = vm.createContext({
    countryByCode: new Map(index.features.map(f => [f.properties.ADM0_A3, f])),
    loadCountryGeometry: async code => {
      calls.push(code);
      return JSON.parse(await read(`data/geography/${code}.json`));
    }
  });
  vm.runInContext(app.slice(app.indexOf('    function longitudeNearPoint'), app.indexOf('    function getApproximateCurrentPosition')), context);
  for (const [lng, lat, code] of [[71.45, 51.17, 'KAZ'], [2.35, 48.85, 'FRA'], [179.4, -16.8, 'FJI']]) {
    calls.length = 0;
    assert.equal(await context.countryAtCoordinates(lng, lat), code);
    assert.ok(calls.length < 10);
  }
  calls.length = 0;
  assert.equal(await context.countryAtCoordinates(-30, 0), null);
  assert.equal(calls.length, 0);
});

test('climate requests are deduplicated and a failed request can be retried', async () => {
  let calls = 0;
  const context = vm.createContext({ fetchCountryClimate: async code => {
    calls++;
    if (code === 'BAD' && calls === 2) throw new Error('offline');
    return { cities: [] };
  } });
  vm.runInContext(app.slice(app.indexOf('    const climateRequests'), app.indexOf('    // Start while')), context);
  const first = context.loadCountryClimate('KAZ');
  assert.equal(context.loadCountryClimate('KAZ'), first);
  await first;
  assert.equal(calls, 1);
  await assert.rejects(context.loadCountryClimate('BAD'), /offline/);
  await context.loadCountryClimate('BAD');
  assert.equal(calls, 3);
});
