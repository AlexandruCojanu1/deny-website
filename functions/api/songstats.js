// Cloudflare Pages Function: GET /api/songstats
// Headline numbers for the stats strip, pulled from Songstats (RapidAPI) once a
// day and cached globally in KV so the whole site costs ONE Songstats request
// per UTC day, however many visitors or edge locations there are.
//
// Secrets (Pages project -> production): SONGSTATS_API_KEY (RapidAPI key).
// Optional: SONGSTATS_BASE_URL + SONGSTATS_DIRECT_KEY for direct Enterprise access.
// Binding: STATS_KV (wrangler.toml). Without it we fall back to the per-colo
// edge cache, which still works but may cost one request per data centre.

const SPOTIFY_ARTIST_ID = "6JgR62Hn12bNkaMXWAFNKP";
const RAPIDAPI_HOST = "songstats.p.rapidapi.com";
// Songstats refresh artist profiles daily and recommend polling around 21:00 UTC.
// We treat the cached numbers as fresh until the next 22:00 UTC boundary, so a
// new day's data is fetched at most once, on the first visit after that hour.
const REFRESH_HOUR_UTC = 22;
const KV_KEY = "songstats:v1";
const ATTEMPT_KEY = "songstats:attempt"; // throttles retries while the API is failing
const ATTEMPT_TTL = 3600; // seconds
const BROWSER_TTL = 3600; // seconds
const EDGE_FALLBACK_TTL = 86400; // seconds, only used without the KV binding

// Which Songstats fields make up each tile. Followers/streams/views/charts are
// summed across every platform Songstats knows the artist on; playlist reach is
// the current reach on the DSPs that expose it; Shazams come from Shazam alone.
const TILES = {
  followers: {
    spotify: ["followers_total"],
    youtube: ["subscribers_total"],
    instagram: ["followers_total"],
    tiktok: ["followers_total"],
    soundcloud: ["followers_total"],
    facebook: ["followers_total"],
    twitter: ["followers_total"],
    deezer: ["followers_total"],
    amazon: ["followers_total"],
    beatport: ["followers_total"],
    songkick: ["followers_total"],
    bandsintown: ["followers_total"],
  },
  streams: {
    spotify: ["streams_total"],
    soundcloud: ["streams_total"],
  },
  views: {
    youtube: ["video_views_total", "short_views_total"],
    tiktok: ["views_total"],
    instagram: ["views_total"],
  },
  playlistReach: {
    spotify: ["playlist_reach_current"],
    deezer: ["playlist_reach_current"],
  },
  shazams: {
    shazam: ["shazams_total"],
  },
  charts: {
    spotify: ["charts_total"],
    apple_music: ["charts_total"],
    amazon: ["charts_total"],
    deezer: ["charts_total"],
    youtube: ["charts_total"],
    shazam: ["charts_total"],
    itunes: ["charts_total"],
    tidal: ["charts_total"],
    soundcloud: ["charts_total"],
    beatport: ["dj_charts_total"],
    traxsource: ["dj_charts_total"],
  },
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Turn the raw /artists/stats response into six numbers plus the per-platform
// breakdown behind each one (handy for checking the sums against Songstats).
export function buildPayload(raw, fetchedAt = new Date().toISOString()) {
  const bySource = new Map();
  for (const entry of raw?.stats || []) {
    if (entry && entry.source && entry.data) bySource.set(entry.source, entry.data);
  }
  const stats = {};
  const breakdown = {};
  for (const [tile, sources] of Object.entries(TILES)) {
    let total = null;
    const parts = {};
    for (const [source, keys] of Object.entries(sources)) {
      const data = bySource.get(source);
      if (!data) continue;
      let sub = null;
      for (const k of keys) {
        const v = num(data[k]);
        if (v !== null) sub = (sub || 0) + v;
      }
      if (sub !== null) {
        parts[source] = sub;
        total = (total || 0) + sub;
      }
    }
    stats[tile] = total;
    breakdown[tile] = parts;
  }
  const info = raw?.artist_info || {};
  return {
    artist: {
      name: info.name || "DENY",
      songstatsId: info.songstats_artist_id || null,
      url: info.site_url || null,
      avatar: info.avatar || null,
    },
    stats,
    breakdown,
    sources: [...bySource.keys()],
    fetchedAt,
  };
}

function configured(env) {
  return Boolean(env.SONGSTATS_API_KEY || (env.SONGSTATS_BASE_URL && env.SONGSTATS_DIRECT_KEY));
}

async function fetchStats(env) {
  const direct = Boolean(env.SONGSTATS_BASE_URL && env.SONGSTATS_DIRECT_KEY);
  const base = direct ? env.SONGSTATS_BASE_URL.replace(/\/+$/, "") : `https://${RAPIDAPI_HOST}`;
  const headers = direct
    ? { Accept: "application/json", apikey: env.SONGSTATS_DIRECT_KEY }
    : { Accept: "application/json", "X-RapidAPI-Key": env.SONGSTATS_API_KEY, "X-RapidAPI-Host": RAPIDAPI_HOST };
  const url = `${base}/artists/stats?spotify_artist_id=${SPOTIFY_ARTIST_ID}&source=all`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`songstats ${res.status}: ${text.slice(0, 200)}`);
  const raw = JSON.parse(text);
  if (raw.result && raw.result !== "success") throw new Error(`songstats result=${raw.result}`);
  if (!Array.isArray(raw.stats) || raw.stats.length === 0) throw new Error("songstats: empty stats");
  return buildPayload(raw);
}

// The most recent REFRESH_HOUR_UTC before `now`. Anything fetched after it is today's data.
export function lastBoundary(now = new Date()) {
  const b = new Date(now);
  b.setUTCHours(REFRESH_HOUR_UTC, 0, 0, 0);
  if (b > now) b.setUTCDate(b.getUTCDate() - 1);
  return b;
}

function isFresh(payload, now = new Date()) {
  const t = payload && Date.parse(payload.fetchedAt);
  return Number.isFinite(t) && t >= lastBoundary(now).getTime();
}

function json(payload, { status = 200, stale = false, cache = true } = {}) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cache ? `public, max-age=${BROWSER_TTL}` : "no-store",
  };
  if (stale) headers["X-Stats-Stale"] = "1";
  return Response.json(stale ? { ...payload, stale: true } : payload, { status, headers });
}

export async function onRequestGet({ request, env, waitUntil }) {
  if (!configured(env)) {
    return json({ error: "Songstats credentials not configured" }, { status: 503, cache: false });
  }

  // --- KV path: one request per day for the whole planet. ---
  if (env.STATS_KV) {
    const cached = await env.STATS_KV.get(KV_KEY, "json");
    if (cached && isFresh(cached)) return json(cached);

    // Someone already tried within the last hour and failed: serve what we have.
    const recentAttempt = await env.STATS_KV.get(ATTEMPT_KEY);
    if (recentAttempt && cached) return json(cached, { stale: true });

    await env.STATS_KV.put(ATTEMPT_KEY, new Date().toISOString(), { expirationTtl: ATTEMPT_TTL });
    try {
      const payload = await fetchStats(env);
      await env.STATS_KV.put(KV_KEY, JSON.stringify(payload));
      return json(payload);
    } catch (e) {
      if (cached) return json(cached, { stale: true });
      return json({ error: String(e && e.message ? e.message : e) }, { status: 503, cache: false });
    }
  }

  // --- Fallback without KV: per-colo edge cache, versioned by deploy. ---
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/songstats?v=${env.CF_PAGES_COMMIT_SHA || "dev"}`, request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  try {
    const payload = await fetchStats(env);
    const res = Response.json(payload, {
      headers: {
        "Cache-Control": `public, max-age=${BROWSER_TTL}, s-maxage=${EDGE_FALLBACK_TTL}`,
        "Access-Control-Allow-Origin": "*",
      },
    });
    if (waitUntil) waitUntil(cache.put(cacheKey, res.clone())); else await cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, { status: 503, cache: false });
  }
}
