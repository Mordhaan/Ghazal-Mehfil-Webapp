import type { Catalog, GhazalText, Sher, Track } from "@/lib/types";

/**
 * The catalogue on disk is the archival source of truth. The browser only
 * needs the fields the player renders, so the server components pass these
 * projections across the RSC boundary. Keeping the trim here (instead of
 * editing `data/catalog.json`) means the harvest/rebuild pipeline can keep its
 * full records and the wire payload stays small.
 */

function pickTrack(track: Track): Track {
  return {
    id: track.id,
    tkey: track.tkey,
    title: track.title,
    artist: track.artist,
    mood: track.mood,
    duration: track.duration,
    url: track.url,
    ...(track.ghazalId ? { ghazalId: track.ghazalId } : {}),
    ...(track.poet ? { poet: track.poet } : {}),
  };
}

function pickSher(sher: Sher): Sher {
  return { u: sher.u, r: sher.r, h: sher.h };
}

function pickGhazal(ghazal: GhazalText): GhazalText {
  return {
    id: ghazal.id,
    titleRoman: ghazal.titleRoman,
    titleUrdu: ghazal.titleUrdu,
    titleHindi: ghazal.titleHindi,
    poet: ghazal.poet,
    shers: ghazal.shers.map(pickSher),
  };
}

/**
 * Everything the listening experience needs: moods, the full playable queue
 * and the poems those recordings reference. `album`, `synced` and the legacy
 * `timings` map are deliberately dropped — none of them are read by the UI,
 * and `timings` alone was ~12 KB of dead weight in every page load.
 */
export function playerCatalog(catalog: Catalog): Catalog {
  const tracks = catalog.tracks.map(pickTrack);
  const referenced = new Set(
    tracks.map((track) => track.ghazalId).filter((id): id is string => Boolean(id))
  );
  return {
    generated: catalog.generated,
    moods: catalog.moods,
    tracks,
    ghazals: catalog.ghazals.filter((g) => referenced.has(g.id)).map(pickGhazal),
  };
}

/**
 * The tap studio can only time a recording that has a poem attached. Shipping
 * all 1,500 tracks to `/sync` meant downloading half a megabyte to choose from
 * thirty rows; this projection is the actual working set.
 */
export function syncCatalog(catalog: Catalog): Catalog {
  const available = new Set(
    catalog.tracks
      .map((track) => track.ghazalId)
      .filter((id): id is string => Boolean(id))
  );
  const ghazals = catalog.ghazals.filter((g) => available.has(g.id));
  const known = new Set(ghazals.map((g) => g.id));
  const tracks = catalog.tracks
    .filter((track) => track.ghazalId && known.has(track.ghazalId))
    .map(pickTrack);
  return {
    generated: catalog.generated,
    moods: catalog.moods,
    tracks,
    ghazals: ghazals.map(pickGhazal),
  };
}
