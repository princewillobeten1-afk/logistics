import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWeatherHazard,
  computeWeatherSummary,
  DEFAULT_MAP_LAYERS,
  filterPointsByLayers,
  parseGeoJsonPolygonRings,
  type WeatherStationReading,
} from "./map-layers";

test("filterPointsByLayers toggles warehouse hubs and gateway ports independently", () => {
  const sites = [
    { id: "1", type: "WAREHOUSE" },
    { id: "2", type: "PORT" },
    { id: "3", type: "AIRPORT" },
  ];

  assert.equal(filterPointsByLayers(sites, DEFAULT_MAP_LAYERS).length, 3);
  assert.deepEqual(
    filterPointsByLayers(sites, { ...DEFAULT_MAP_LAYERS, warehouses: false }).map((s) => s.id),
    ["2", "3"],
  );
  assert.deepEqual(
    filterPointsByLayers(sites, { ...DEFAULT_MAP_LAYERS, gateways: false }).map((s) => s.id),
    ["1"],
  );
  assert.equal(
    filterPointsByLayers(sites, { ...DEFAULT_MAP_LAYERS, warehouses: false, gateways: false }).length,
    0,
  );
});

test("parseGeoJsonPolygonRings converts Polygon and MultiPolygon coordinates to LatLng rings", () => {
  const poly = JSON.stringify({
    type: "Polygon",
    coordinates: [
      [
        [3.35, 6.52],
        [3.42, 6.52],
        [3.42, 6.6],
        [3.35, 6.52],
      ],
    ],
  });
  const rings = parseGeoJsonPolygonRings(poly);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
  assert.deepEqual(rings[0][0], { lat: 6.52, lng: 3.35 });

  assert.deepEqual(parseGeoJsonPolygonRings("not-json"), []);
  assert.deepEqual(parseGeoJsonPolygonRings(null), []);
});

test("classifyWeatherHazard classifies clear, wind advisory, fog, and severe storm states", () => {
  const clear = classifyWeatherHazard({
    wmoCode: 0,
    windSpeedKmh: 9,
    windGustsKmh: 20,
    precipitationMm: 0,
    temperatureC: 29,
  });
  assert.equal(clear.severity, "CLEAR");
  assert.equal(clear.hazardReasons.length, 0);

  const windAdv = classifyWeatherHazard({
    wmoCode: 1,
    windSpeedKmh: 22,
    windGustsKmh: 41,
    precipitationMm: 0,
    temperatureC: 31,
  });
  assert.equal(windAdv.severity, "ADVISORY");
  assert.match(windAdv.hazardReasons[0], /crosswinds/i);

  const storm = classifyWeatherHazard({
    wmoCode: 95,
    windSpeedKmh: 45,
    windGustsKmh: 62,
    precipitationMm: 14,
    temperatureC: 26,
  });
  assert.equal(storm.severity, "SEVERE");
  assert.ok(storm.hazardReasons.length >= 2);
});

test("computeWeatherSummary counts stations with non-clear hazards", () => {
  const stations: WeatherStationReading[] = [
    {
      siteId: "los",
      siteName: "Lagos",
      city: "Lagos",
      lat: 6.52,
      lng: 3.38,
      provider: "open-meteo",
      severity: "CLEAR",
      conditionLabel: "Clear sky",
      temperatureC: 29,
      windSpeedKmh: 9,
      windGustsKmh: 22,
      precipitationMm: 0,
      observedAt: null,
      advisoryReasons: [],
      alerts: [],
      attribution: { name: "Open-Meteo", authorityUri: "https://open-meteo.com/" },
    },
    {
      siteId: "kan",
      siteName: "Kano",
      city: "Kano",
      lat: 12.0,
      lng: 8.51,
      provider: "open-meteo",
      severity: "ADVISORY",
      conditionLabel: "Clear sky",
      temperatureC: 39,
      windSpeedKmh: 15,
      windGustsKmh: 40,
      precipitationMm: 0,
      observedAt: null,
      advisoryReasons: ["High ambient heat"],
      alerts: [],
      attribution: { name: "Open-Meteo", authorityUri: "https://open-meteo.com/" },
    },
  ];

  const summary = computeWeatherSummary(stations);
  assert.equal(summary.totalStations, 2);
  assert.equal(summary.alertCount, 1);
  assert.equal(summary.activeAlerts[0].siteId, "kan");
});
