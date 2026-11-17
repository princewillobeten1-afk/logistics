import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCorridorGroundingPrompt,
  extractMapsGroundingSources,
  extractPointFromAddress,
  isQuotaErrorMessage,
  resolveLocationCoordinates,
} from "./maps-grounding";

test("extractMapsGroundingSources extracts deduplicated Maps URLs and review snippets", () => {
  const sources = extractMapsGroundingSources([
    {
      groundingMetadata: {
        groundingChunks: [
          {
            maps: {
              uri: "https://maps.google.com/?cid=101",
              title: "Apapa Port Complex",
              placeId: "place_101",
              placeAnswerSources: {
                reviewSnippets: [
                  {
                    reviewText: "Heavy container truck staging along Wharf Road.",
                    googleMapsUri: "https://maps.google.com/review/1",
                    authorAttribution: { displayName: "Tunde A." },
                  },
                ],
              },
            },
          },
          {
            maps: {
              uri: "https://maps.google.com/?cid=101",
              title: "Apapa Port Complex",
              placeAnswerSources: {
                reviewSnippets: [
                  {
                    text: "Customs gate inspection open 24h.",
                  },
                ],
              },
            },
          },
          {
            maps: {
              uri: "https://maps.google.com/?cid=202",
              title: "Tema Harbour Terminal",
            },
          },
        ],
      },
    },
  ]);

  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, "Apapa Port Complex");
  assert.equal(sources[0].placeId, "place_101");
  assert.equal(sources[0].reviewSnippets.length, 2);
  assert.equal(sources[0].reviewSnippets[0].author, "Tunde A.");
  assert.equal(sources[1].uri, "https://maps.google.com/?cid=202");
  assert.equal(sources[1].reviewSnippets.length, 0);
});

test("extractMapsGroundingSources handles empty or missing candidates safely", () => {
  assert.deepEqual(extractMapsGroundingSources(undefined), []);
  assert.deepEqual(extractMapsGroundingSources([]), []);
  assert.deepEqual(extractMapsGroundingSources([{}]), []);
});

test("isQuotaErrorMessage detects quota exhaustion without false positives", () => {
  assert.equal(isQuotaErrorMessage("OverQuotaMapError: limit reached"), true);
  assert.equal(isQuotaErrorMessage("QuotaExceededError"), true);
  assert.equal(isQuotaErrorMessage("OVER_QUERY_LIMIT"), true);
  assert.equal(isQuotaErrorMessage("RESOURCE_EXHAUSTED"), true);
  assert.equal(isQuotaErrorMessage("Any error", 429), true);

  assert.equal(isQuotaErrorMessage("No route found", 200), false);
  assert.equal(isQuotaErrorMessage("ZERO_RESULTS", 200), false);
  assert.equal(isQuotaErrorMessage("Network timeout", 500), false);
});

test("resolveLocationCoordinates matches configured cities and hubs", () => {
  const sites = [
    { city: "Lagos", name: "Lagos Central DC", code: "LOS-DC1", latitude: "6.6018", longitude: "3.3515" },
    { city: "Abuja", name: "Abuja Garki Hub", code: "ABV-HUB", latitude: "9.0579", longitude: "7.4951" },
  ];

  assert.deepEqual(resolveLocationCoordinates("Lagos", sites), { lat: 6.6018, lng: 3.3515 });
  assert.deepEqual(resolveLocationCoordinates("ABV-HUB", sites), { lat: 9.0579, lng: 7.4951 });
  assert.equal(resolveLocationCoordinates("Mars", sites), null);
});

test("extractPointFromAddress extracts explicit shipment coordinates safely", () => {
  assert.deepEqual(extractPointFromAddress({ city: "Tema", lat: 5.6698, lon: -0.0166 }), {
    lat: 5.6698,
    lng: -0.0166,
  });
  assert.deepEqual(extractPointFromAddress({ latitude: "6.45", longitude: "3.39" }), {
    lat: 6.45,
    lng: 3.39,
  });
  assert.equal(extractPointFromAddress({ city: "Lagos" }), null);
  assert.equal(extractPointFromAddress(null), null);
});

test("buildCorridorGroundingPrompt includes corridor and mode context", () => {
  const prompt = buildCorridorGroundingPrompt({
    question: "Where are truck staging areas?",
    originCity: "Lagos",
    destinationCity: "Tema",
    modes: ["ROAD", "SEA"],
  });

  assert.match(prompt, /Lagos to Tema/);
  assert.match(prompt, /ROAD, SEA/);
  assert.match(prompt, /Where are truck staging areas\?/);
});
