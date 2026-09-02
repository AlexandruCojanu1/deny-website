// Cloudflare Pages Function: GET /api/spotify
// Returns DENY's latest Spotify releases (client-credentials flow, cached 1h).
// Secrets (Pages project → production): SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET.

const ARTIST_ID = "6JgR62Hn12bNkaMXWAFNKP";
const ARTIST_URL = `https://open.spotify.com/artist/${ARTIST_ID}`;
const CACHE_TTL = 3600; // seconds
const MAX_RELEASES = 9; // 1 featured + 8 rows

async function getToken(env) {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

// Spotify caps `limit` at 10 for this app; page through until exhausted (max 5 pages).
async function fetchAlbums(token, groups) {
  const items = [];
  for (let offset = 0, page = 0; page < 5; offset += 10, page++) {
    const url = `https://api.spotify.com/v1/artists/${ARTIST_ID}/albums?include_groups=${groups}&limit=10&offset=${offset}&market=RO`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`albums ${res.status}`);
    const json = await res.json();
    items.push(...(json.items || []));
    if (!json.next) break;
  }
  return items;
}

export function buildPayload(credited, appearsOn) {
  // Own releases + remixes credited to Deny that live on other artists' releases.
  const all = [...credited, ...appearsOn.filter((a) => /deny/i.test(a.name))];
  const seen = new Set();
  const releases = all
    .filter((a) => a && a.id && !seen.has(a.name.toLowerCase()) && seen.add(a.name.toLowerCase()))
    .sort((a, b) => (b.release_date > a.release_date ? 1 : b.release_date < a.release_date ? -1 : 0))
    .slice(0, MAX_RELEASES)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.album_type, // album | single | compilation
      date: a.release_date,
      tracks: a.total_tracks,
      artists: (a.artists || []).map((x) => x.name),
      image: (a.images || []).sort((x, y) => (y.width || 0) - (x.width || 0))[0]?.url || null,
      thumb: (a.images || []).sort((x, y) => (x.width || 0) - (y.width || 0))[0]?.url || null,
      url: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`,
    }));
  return { artist: { name: "DENY", url: ARTIST_URL }, latest: releases[0] || null, releases, fetchedAt: new Date().toISOString() };
}

export async function onRequestGet({ request, env }) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return Response.json({ error: "Spotify credentials not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const cache = caches.default;
  // Cache key carries the deploy sha so every new deploy starts with a fresh cache.
  const cacheKey = new Request(new URL(`/api/spotify?v=${env.CF_PAGES_COMMIT_SHA || "dev"}`, request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const token = await getToken(env);
    const [credited, appearsOn] = await Promise.all([fetchAlbums(token, "album,single"), fetchAlbums(token, "appears_on")]);
    const payload = buildPayload(credited, appearsOn);
    const res = Response.json(payload, {
      headers: {
        "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
        "Access-Control-Allow-Origin": "*",
      },
    });
    await cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
