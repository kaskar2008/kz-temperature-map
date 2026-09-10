import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  buildPlacesByCountry,
  mergeWmoStations,
  parseClimateNumber,
  parseElevation,
} from '../tools/build-climate-data.mjs';

const climateDirectory = new URL('../data/climate/', import.meta.url);

test('client renders missing temperatures without treating them as cold weather', async () => {
  const app = await readFile(new URL('../assets/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(
    app.slice(app.indexOf('    function hasTemperature'), app.indexOf('    function createMarkerElement')),
    context,
  );

  assert.equal(context.hasTemperature(-99.9), false);
  assert.equal(context.hasTemperature(null), false);
  assert.equal(context.formatTemp(-99.9), '—');
  assert.equal(context.formatTemp(null, 'Нет данных'), 'Нет данных');
  assert.equal(context.temperatureColor(-99.9), '#64748b');
});

test('WMO missing markers and invalid elevations are parsed as missing', () => {
  assert.equal(parseClimateNumber('-99.9'), null);
  assert.equal(parseClimateNumber('-999'), null);
  assert.equal(parseClimateNumber(''), null);
  assert.equal(parseClimateNumber(' 24.26 '), 24.3);
  assert.equal(parseElevation('-876.5'), null);
  assert.equal(parseElevation('-9999'), null);
  assert.equal(parseElevation('-430'), -430);
});

test('incomplete or internally inconsistent WMO stations are rejected', () => {
  const station = {
    key: 'station',
    id: 'station',
    mean: Array(12).fill(20),
    min: Array(12).fill(15),
    max: Array(12).fill(25),
  };

  assert.equal(mergeWmoStations({ mean: [station], min: [station], max: [station] }).length, 1);

  const missing = { ...station, mean: [...station.mean] };
  missing.mean[4] = null;
  assert.equal(mergeWmoStations({ mean: [missing], min: [missing], max: [missing] }).length, 0);

  const inconsistent = { ...station, mean: [...station.mean] };
  inconsistent.mean[4] = 10;
  assert.equal(
    mergeWmoStations({ mean: [inconsistent], min: [inconsistent], max: [inconsistent] }).length,
    0,
  );
});

test('generated climate data contains only complete and consistent temperature rows', async () => {
  const filenames = (await readdir(climateDirectory)).filter(name => /^[A-Z]{3}\.json$/.test(name));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', climateDirectory), 'utf8'));
  assert.equal(filenames.length, manifest.countries.length);

  for (const filename of filenames) {
    const payload = JSON.parse(await readFile(new URL(filename, climateDirectory), 'utf8'));
    for (const city of payload.cities || []) {
      for (const field of ['temps', 'avgLow', 'avgHigh']) {
        assert.equal(city[field]?.length, 12, `${filename} ${city.name} ${field}`);
        for (const value of city[field]) {
          assert.ok(
            Number.isFinite(value) && value > -90 && value < 60,
            `${filename} ${city.name} ${field}: ${value}`,
          );
        }
      }

      for (let month = 0; month < 12; month += 1) {
        assert.ok(
          city.avgLow[month] <= city.temps[month] && city.temps[month] <= city.avgHigh[month],
          `${filename} ${city.name}, month ${month + 1}: ` +
            `${city.avgLow[month]} <= ${city.temps[month]} <= ${city.avgHigh[month]}`,
        );
      }

      assert.ok(
        city.alt == null || (city.alt >= -500 && city.alt <= 9000),
        `${filename} ${city.name} altitude: ${city.alt}`,
      );
    }
  }
});

test('Georgia has climate points across its coast, mountains, south, and east', async () => {
  const patch = JSON.parse(
    await readFile(new URL('../patches/countries/GEO.json', import.meta.url), 'utf8'),
  );
  const georgia = JSON.parse(await readFile(new URL('GEO.json', climateDirectory), 'utf8'));
  const cities = new Map(georgia.cities.map(city => [city.name, city]));

  assert.equal(patch.placeStrategy, 'merge');
  assert.equal(patch.places.length, 13);
  assert.equal(georgia.cities.length, 20);
  for (const name of ['Batumi', 'Mestia', 'Stepantsminda', 'Akhalkalaki', 'Lagodekhi', 'Dedoplistsqaro']) {
    assert.ok(cities.has(name), `GEO.json is missing ${name}`);
  }

  const supplemental = georgia.cities.filter(city => city.locationSource?.name === 'GeoNames');
  assert.equal(supplemental.length, 13);
  assert.ok(supplemental.every(city => /^\d+$/.test(city.locationSource.id)));
  assert.ok(supplemental.every(city => /^https:\/\/www\.geonames\.org\/\d+$/.test(city.locationSource.url)));
});

test('country place patches support merge/upsert and full replacement', () => {
  const feature = (name, lng) => ({
    type: 'Feature',
    properties: { adm0_a3: 'TST', name },
    geometry: { type: 'Point', coordinates: [lng, 1] },
  });
  const place = (name, lng) => ({ name, lng, lat: 1 });
  const base = [feature('Existing', 1), feature('Untouched', 2)];

  const merged = buildPlacesByCountry(base, new Map([['TST', {
    placeStrategy: 'merge',
    places: [place('Existing', 3), place('Added', 4)],
  }]])).get('TST');
  assert.deepEqual(merged.map(item => item.properties.name), ['Untouched', 'Existing', 'Added']);
  assert.equal(merged.find(item => item.properties.name === 'Existing').geometry.coordinates[0], 3);

  const replaced = buildPlacesByCountry(base, new Map([['TST', {
    placeStrategy: 'replace',
    places: [place('Only patch', 5)],
  }]])).get('TST');
  assert.deepEqual(replaced.map(item => item.properties.name), ['Only patch']);
});
