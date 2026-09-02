// Cloudflare Pages Function: GET /api/gigs
// Upcoming shows from Bandsintown's public API, normalised for the site and cached 1h.
//
// DENY's own verified profile is id 15565982 (linked to his Spotify/Apple artist
// ids). Beware: a plain name lookup ("deny") resolves to id 424659, a shared
// profile dominated by an Argentinian singer, so always address the artist by id.
// The Latin-America / "DENY en <city>" filter below only matters if the profile
// is ever switched back to that shared one (BANDSINTOWN_ARTIST env var).

const DEFAULT_ARTIST = "id_15565982";
const DEFAULT_APP_ID = "js_dancewithdeny.com"; // widget-style app ids are accepted by the public API
const CACHE_TTL = 3600;
const MAX_EVENTS = 24;

const EXCLUDED_COUNTRIES = new Set([
  "argentina", "chile", "peru", "colombia", "mexico", "brazil", "uruguay", "paraguay", "bolivia",
  "ecuador", "venezuela", "guatemala", "costa rica", "panama", "dominican republic", "puerto rico",
  "el salvador", "honduras", "nicaragua", "cuba",
]);
const EXCLUDED_TITLE = /^\s*deny\s+en\s+/i;

export function normaliseEvents(raw) {
  const events = (Array.isArray(raw) ? raw : [])
    .filter((e) => e && e.datetime && e.venue)
    .filter((e) => !EXCLUDED_COUNTRIES.has(String(e.venue.country || "").toLowerCase()))
    .filter((e) => !EXCLUDED_TITLE.test(e.title || "") && !EXCLUDED_TITLE.test((e.venue && e.venue.name) || ""))
    .map((e) => ({
      id: String(e.id),
      date: e.datetime, // local venue time, ISO without offset
      title: (e.title || "").trim(),
      description: (e.description || "").trim(),
      venue: { name: (e.venue.name || "").trim(), city: (e.venue.city || "").trim(), region: (e.venue.region || "").trim(), country: (e.venue.country || "").trim() },
      lineup: (e.lineup || []).map((x) => String(x).trim()).filter((x) => x && !/^deny$/i.test(x)),
      url: e.url || "",
      tickets: (e.offers || []).find((o) => o && o.type === "Tickets" && o.url)?.url || "",
    }))
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0))
    .slice(0, MAX_EVENTS);
  return events;
}

export async function onRequestGet({ request, env }) {
  const artist = env.BANDSINTOWN_ARTIST || DEFAULT_ARTIST;
  const appId = env.BANDSINTOWN_APP_ID || DEFAULT_APP_ID;
  const cache = caches.default;
  // Cache key carries the deploy sha so every new deploy starts with a fresh cache.
  const cacheKey = new Request(new URL(`/api/gigs?v=${env.CF_PAGES_COMMIT_SHA || "dev"}`, request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const base = `https://rest.bandsintown.com/artists/${encodeURIComponent(artist)}`;
    const [evRes, arRes] = await Promise.all([
      fetch(`${base}/events?app_id=${encodeURIComponent(appId)}&date=upcoming`, { headers: { Accept: "application/json" } }),
      fetch(`${base}?app_id=${encodeURIComponent(appId)}`, { headers: { Accept: "application/json" } }),
    ]);
    if (!evRes.ok) throw new Error(`bandsintown events ${evRes.status}`);
    const raw = await evRes.json();
    const artistInfo = arRes.ok ? await arRes.json().catch(() => null) : null;
    const events = normaliseEvents(raw);
    const payload = {
      artist: {
        name: "DENY",
        url: (artistInfo && artistInfo.url ? String(artistInfo.url).split("?")[0] : `https://www.bandsintown.com/a/${artist.replace(/^id_/, "")}`),
      },
      events,
      count: events.length,
      fetchedAt: new Date().toISOString(),
    };
    const res = Response.json(payload, {
      headers: { "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`, "Access-Control-Allow-Origin": "*" },
    });
    await cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
