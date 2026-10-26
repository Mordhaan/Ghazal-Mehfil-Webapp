export type Mood = {
  id: string;
  name: string;
  urdu_name: string;
  vibe_description: string;
  color: string;
  bg_gradient: string;
  tags: string[];
  keywords?: string[];
};

export type Sher = {
  u: string;
  r: string;
  h: string;
  start?: number;
  end?: number;
};

export type TrackTiming = {
  sherIndex: number;
  start: number;
  end: number;
};

export type Track = {
  id: string;
  /** Stable media key for timing files; survives catalogue rebuilds. */
  tkey?: string;
  title: string;
  artist: string;
  mood: string;
  duration: number;
  url: string;
  album?: string;
  ghazalId?: string;
  poet?: string;
  timings?: TrackTiming[];
  shers?: Sher[];
};

export type GhazalText = {
  id: string;
  titleRoman: string;
  titleUrdu: string;
  titleHindi: string;
  poet: string;
  shers: Sher[];
};

export type Catalog = {
  generated: string;
  moods: Mood[];
  tracks: Track[];
  ghazals: GhazalText[];
  /** Measured lyric timing per track id (see scraper/align_timings.py). */
  timings?: Record<string, unknown>;
};

export type ScriptMode = "urdu" | "roman" | "hindi";
