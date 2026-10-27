#!/usr/bin/env node
/**
 * Pre-build data gate. The app trusts two files — `data/catalog.json` and the
 * timing manifest — so a malformed rebuild must fail here rather than shipping
 * a player that points at the wrong poem.
 *
 *   node scripts/verify-data.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8"));
  } catch (err) {
    fail(`cannot read ${rel}: ${err.message}`);
    return null;
  }
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function check(condition, message) {
  if (!condition) fail(message);
  return condition;
}

const catalog = readJson("data/catalog.json");
const indexDoc = readJson("public/timings/index.json");

if (!catalog || !indexDoc) {
  for (const message of errors) console.error(`  error ${message}`);
  console.error("\ndata verification failed: catalogue or timing manifest is unreadable");
  process.exit(1);
}

const moods = Array.isArray(catalog.moods) ? catalog.moods : [];
const tracks = Array.isArray(catalog.tracks) ? catalog.tracks : [];
const ghazals = Array.isArray(catalog.ghazals) ? catalog.ghazals : [];

check(moods.length > 0, "catalogue has no moods");
check(tracks.length > 0, "catalogue has no tracks");
check(ghazals.length > 0, "catalogue has no poems");

const moodIds = new Set();
for (const mood of moods) {
  check(isText(mood.id), "a mood has no id");
  check(isText(mood.name), `mood ${mood.id ?? "?"} has no name`);
  check(/^#[0-9a-f]{6}$/i.test(mood.color ?? ""), `mood ${mood.id} has an invalid colour`);
  if (moodIds.has(mood.id)) fail(`duplicate mood id: ${mood.id}`);
  moodIds.add(mood.id);
}

const ghazalById = new Map();
for (const ghazal of ghazals) {
  check(isText(ghazal.id), "a poem has no id");
  if (ghazalById.has(ghazal.id)) fail(`duplicate poem id: ${ghazal.id}`);
  const shers = Array.isArray(ghazal.shers) ? ghazal.shers : [];
  check(shers.length > 0, `poem ${ghazal.id} has no couplets`);
  for (const [i, sher] of shers.entries()) {
    for (const field of ["u", "r", "h"]) {
      check(isText(sher[field]), `poem ${ghazal.id} sher ${i} is missing script "${field}"`);
    }
  }
  if (!isText(ghazal.poet)) warn(`poem ${ghazal.id} has no poet`);
  ghazalById.set(ghazal.id, ghazal);
}

const trackIds = new Set();
const trackByKey = new Map();
for (const track of tracks) {
  const where = `track ${track.id ?? "?"}`;
  check(isText(track.id), "a track has no id");
  check(isText(track.title), `${where} has no title`);
  check(isText(track.artist), `${where} has no artist`);
  check(isText(track.url), `${where} has no url`);
  check(typeof track.url === "string" && track.url.startsWith("https://"), `${where} has a non-https url`);
  check(typeof track.duration === "number" && track.duration >= 0, `${where} has a bad duration`);
  check(moodIds.has(track.mood), `${where} references unknown mood ${track.mood}`);
  check(/^[0-9a-f]{16}$/.test(track.tkey ?? ""), `${where} has an invalid media key`);
  if (trackIds.has(track.id)) fail(`duplicate track id: ${track.id}`);
  trackIds.add(track.id);
  if (trackByKey.has(track.tkey)) fail(`duplicate media key: ${track.tkey}`);
  trackByKey.set(track.tkey, track);
  if (track.ghazalId) {
    check(ghazalById.has(track.ghazalId), `${where} references missing poem ${track.ghazalId}`);
  }
}

const manifest = indexDoc.tracks && typeof indexDoc.tracks === "object" ? indexDoc.tracks : null;
check(Boolean(manifest), "timing manifest has no tracks map");

let timedFiles = 0;
if (manifest) {
  for (const key of Object.keys(manifest)) {
    const track = trackByKey.get(key);
    if (!track) {
      fail(`timing manifest has key ${key} that no recording uses`);
      continue;
    }
    if (!track.ghazalId) {
      fail(`recording ${track.id} has a timing but no poem`);
      continue;
    }
    const file = `public/timings/${key}.json`;
    if (!existsSync(join(root, file))) {
      fail(`timing file missing: ${file}`);
      continue;
    }
    const doc = readJson(file);
    if (!doc) continue;
    timedFiles += 1;
    check(doc.v === 3, `${file} is not v3`);
    check(["asr", "manual", "segmented"].includes(doc.method), `${file} has an unknown method`);
    const shers = Array.isArray(doc.shers) ? doc.shers : [];
    check(shers.length > 0, `${file} has no occurrences`);
    const written = ghazalById.get(track.ghazalId).shers.length;
    let previousStart = -1;
    for (const [i, sher] of shers.entries()) {
      check(
        Number.isInteger(sher.i) && sher.i >= 0 && sher.i < written,
        `${file} sher ${i} points outside the poem (${sher.i} / ${written})`
      );
      check(
        typeof sher.start === "number" &&
          typeof sher.end === "number" &&
          sher.end > sher.start,
        `${file} sher ${i} has an invalid span`
      );
      if (typeof sher.start === "number" && sher.start < previousStart - 0.03) {
        fail(`${file} sher ${i} starts before the previous one`);
      }
      previousStart = Math.max(previousStart, sher.end ?? previousStart);
      for (const [k, line] of (sher.lines ?? []).entries()) {
        check(
          line.m === 0 || line.m === 1,
          `${file} sher ${i} line ${k} has misra ${line.m}`
        );
        check(
          typeof line.start === "number" &&
            typeof line.end === "number" &&
            line.end > line.start,
          `${file} sher ${i} line ${k} has an invalid span`
        );
      }
    }
    const entry = manifest[key];
    check(typeof entry.q === "number" && entry.q >= 0 && entry.q <= 1, `${file} has no quality`);
  }
}

for (const track of tracks) {
  if (track.ghazalId && !manifest?.[track.tkey]) {
    warn(`poem-bearing recording ${track.id} has no measured timing`);
  }
}

function report() {
  const poemTracks = tracks.filter((t) => t.ghazalId).length;
  console.log(
    `catalogue: ${tracks.length} recordings · ${poemTracks} with a poem · ${ghazals.length} poems`
  );
  console.log(`timings:   ${timedFiles} validated files · ${Object.keys(manifest ?? {}).length} manifest keys`);
  for (const message of warnings.slice(0, 8)) console.log(`  warn  ${message}`);
  if (warnings.length > 8) console.log(`  warn  … ${warnings.length - 8} more`);
  if (errors.length) {
    for (const message of errors.slice(0, 20)) console.error(`  error ${message}`);
    if (errors.length > 20) console.error(`  error … ${errors.length - 20} more`);
    console.error(`\ndata verification failed: ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log("data verification passed");
}

report();
