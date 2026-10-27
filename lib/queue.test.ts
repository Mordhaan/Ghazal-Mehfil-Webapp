import test from "node:test";
import assert from "node:assert/strict";

import { applyTimedFilter, clampIndex, hasTiming, timingKey } from "./queue.ts";
import type { Track } from "./types.ts";

function track(id: string, tkey?: string): Track {
  return {
    id,
    tkey,
    title: id,
    artist: "test",
    mood: "m",
    duration: 10,
    url: `https://example.org/${id}.mp3`,
  };
}

const a = track("a", "key-a");
const b = track("b", "key-b");
const c = track("c");

test("timingKey prefers the media hash and falls back to the id", () => {
  assert.equal(timingKey(a), "key-a");
  assert.equal(timingKey(c), "c");
});

test("hasTiming reads the manifest key set", () => {
  const keys = new Set(["key-a"]);
  assert.equal(hasTiming(a, keys), true);
  assert.equal(hasTiming(b, keys), false);
  assert.equal(hasTiming(c, keys), false);
  assert.equal(hasTiming(a, null), false);
});

test("applyTimedFilter does not filter until the manifest is known", () => {
  assert.deepEqual(applyTimedFilter([a, b, c], null), [a, b, c]);
  assert.deepEqual(applyTimedFilter([a, b, c], new Set(["key-b"])), [b]);
  assert.deepEqual(applyTimedFilter([a, b, c], new Set()), []);
});

test("clampIndex keeps the transport inside the queue", () => {
  assert.equal(clampIndex(0, 3), 0);
  assert.equal(clampIndex(2, 3), 2);
  assert.equal(clampIndex(7, 3), 2);
  assert.equal(clampIndex(-4, 3), 0);
  assert.equal(clampIndex(Number.NaN, 3), 0);
  assert.equal(clampIndex(4, 0), 0);
});
