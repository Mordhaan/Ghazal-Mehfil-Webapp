import test from "node:test";
import assert from "node:assert/strict";

import {
  isKaraoke,
  lineStateAt,
  normalizeTiming,
  occurrenceAt,
  phaseAt,
  qualityScore,
  type TrackTiming,
} from "./timing.ts";

const timing: TrackTiming = normalizeTiming({
  v: 3,
  duration: 100,
  method: "asr",
  phrases: [[10, 20], [30, 45]],
  interludes: [[0, 10], [20, 30]],
  shers: [
    {
      i: 0,
      pass: 0,
      start: 10,
      end: 20,
      lines: [
        { m: 0, start: 10, end: 14, words: [[10, 11], [11, 12], [12, 13], [13, 14]] },
        { m: 1, start: 15, end: 20, words: [[15, 16.5], [16.5, 18], [18, 20]] },
      ],
    },
    { i: 1, pass: 0, start: 30, end: 45, lines: [{ m: 0, start: 30, end: 37 }, { m: 1, start: 39, end: 45 }] },
  ],
})!;

test("normalizeTiming keeps the written sher index", () => {
  assert.equal(timing.shers.length, 2);
  assert.deepEqual(timing.shers.map((s) => s.i), [0, 1]);
  assert.equal(timing.method, "asr");
});

test("normalizeTiming accepts v1 array lines", () => {
  const v1 = normalizeTiming({
    duration: 40,
    shers: [{ i: 3, start: 5, end: 12, lines: [[5, 8], [9, 12]] }],
  })!;
  assert.equal(v1.shers[0].lines?.[0].m, 0);
  assert.equal(v1.shers[0].lines?.[1].start, 9);
  assert.equal(v1.method, "segmented");
});

test("normalizeTiming rejects empty or impossible documents", () => {
  assert.equal(normalizeTiming(null), null);
  assert.equal(normalizeTiming({ duration: 10, shers: [] }), null);
  assert.equal(
    normalizeTiming({ duration: 10, shers: [{ i: 0, start: 8, end: 4 }] }),
    null
  );
});

test("occurrenceAt holds the last started couplet through an interlude", () => {
  assert.equal(occurrenceAt(timing.shers, 5), -1);
  assert.equal(occurrenceAt(timing.shers, 10), 0);
  assert.equal(occurrenceAt(timing.shers, 19.9), 0);
  assert.equal(occurrenceAt(timing.shers, 25), 0); // interlude after sher 0
  assert.equal(occurrenceAt(timing.shers, 31), 1);
});

test("phaseAt distinguishes intro, verse, interlude, outro", () => {
  assert.equal(phaseAt(timing, 0), "intro");
  assert.equal(phaseAt(timing, 12), "verse");
  assert.equal(phaseAt(timing, 25), "interlude");
  assert.equal(phaseAt(timing, 50), "outro");
  assert.equal(phaseAt(null, 12), "untimed");
});

test("lineStateAt walks misras and words inside a couplet", () => {
  assert.deepEqual(lineStateAt(timing.shers[0], 10.5), { line: 0, word: 0, inside: true });
  assert.deepEqual(lineStateAt(timing.shers[0], 12.5), { line: 0, word: 2, inside: true });
  // breath between the two misras: neither line is highlighted
  assert.deepEqual(lineStateAt(timing.shers[0], 14.5), { line: 0, word: -1, inside: false });
  assert.deepEqual(lineStateAt(timing.shers[0], 17), { line: 1, word: 1, inside: true });
  assert.deepEqual(lineStateAt(undefined, 17), { line: -1, word: -1, inside: false });
});

test("karaoke requires measured word spans", () => {
  assert.equal(isKaraoke(timing), true);
  const segmented = normalizeTiming({
    duration: 40,
    method: "segmented",
    shers: [{ i: 0, start: 5, end: 12, lines: [[5, 8], [9, 12]] }],
  })!;
  assert.equal(isKaraoke(segmented), false);
});

test("qualityScore reads both number and object forms", () => {
  assert.equal(qualityScore({ ...timing, quality: { score: 0.8 } }), 0.8);
  assert.equal(qualityScore({ ...timing, quality: 0.4 }), 0.4);
  assert.equal(qualityScore(null), 0);
});

test("normalizeTiming repairs small overlaps without dropping verses", () => {
  const doc = normalizeTiming({
    duration: 30,
    shers: [
      { i: 0, start: 5, end: 12, lines: [{ m: 0, start: 5, end: 12 }] },
      { i: 1, start: 11.99, end: 18, lines: [{ m: 0, start: 11.99, end: 18 }] },
    ],
  })!;
  assert.ok(doc.shers[1].start >= doc.shers[0].end - 0.03);
  assert.ok(doc.shers[1].end > doc.shers[1].start);
});
