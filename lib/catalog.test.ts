import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { playerCatalog, syncCatalog } from "./catalog.ts";
import type { Catalog } from "./types.ts";

const catalog = JSON.parse(
  readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8")
) as Catalog;

test("playerCatalog keeps the playable corpus and drops unused fields", () => {
  const slim = playerCatalog(catalog);
  assert.equal(slim.tracks.length, catalog.tracks.length);
  assert.equal(slim.moods.length, catalog.moods.length);
  assert.equal((slim as { timings?: unknown }).timings, undefined);

  for (const track of slim.tracks) {
    assert.equal(typeof track.url, "string");
    assert.ok(track.url.startsWith("https://"));
    assert.equal("album" in track, false);
    assert.equal("synced" in track, false);
    if (track.ghazalId) {
      assert.ok(slim.ghazals.some((g) => g.id === track.ghazalId));
    }
  }

  const before = JSON.stringify(catalog.tracks).length;
  const after = JSON.stringify(slim.tracks).length;
  assert.ok(after < before, `expected a smaller payload (${after} < ${before})`);
});

test("playerCatalog does not mutate the source catalogue", () => {
  const first = catalog.tracks[0];
  assert.equal(typeof first.album, "string");
  playerCatalog(catalog);
  assert.equal(catalog.tracks[0].album, first.album);
});

test("each projected ghazal keeps three scripts per couplet", () => {
  const slim = playerCatalog(catalog);
  for (const ghazal of slim.ghazals) {
    assert.ok(ghazal.shers.length > 0);
    for (const sher of ghazal.shers) {
      assert.equal(typeof sher.u, "string");
      assert.ok(sher.u.length > 0);
      assert.equal(typeof sher.r, "string");
      assert.equal(typeof sher.h, "string");
    }
  }
});

test("syncCatalog is the working set the studio can actually time", () => {
  const slim = syncCatalog(catalog);
  const expected = catalog.tracks.filter((t) => t.ghazalId);
  assert.equal(slim.tracks.length, expected.length);
  assert.ok(slim.tracks.length > 0);
  assert.ok(slim.tracks.length < catalog.tracks.length);
  for (const track of slim.tracks) {
    assert.ok(track.ghazalId);
    assert.ok(slim.ghazals.some((g) => g.id === track.ghazalId));
  }
  assert.ok(
    JSON.stringify(slim).length < JSON.stringify(catalog).length / 4,
    "the studio payload should be a fraction of the catalogue"
  );
});
