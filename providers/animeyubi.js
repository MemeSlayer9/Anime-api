import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { request, gql } from 'graphql-request';
import crypto from 'crypto';


const app = express();

const router = express.Router();
app.use(cors());

// ============================================
// CONSTANTS
// ============================================

const ALLANIME_BASE = "https://allanime.day";
const ALLANIME_API  = "https://api.allanime.day/api";
const SKIP_SOURCES  = ["Ak", "Yt-mp4", "Vid-mp4", "Sl-mp4"];
const ANILIST_API   = "https://graphql.anilist.co";
const TMDB_API      = "https://api.themoviedb.org/3";
const TMDB_KEY      = process.env.TMDB_API_KEY || '699be86b7a4ca2c8bc77525cb4938dc0';

// ============================================
// GraphQL QUERY STRINGS
// ============================================
const SEARCH_GQL = `
query(
  $search: SearchInput
  $limit: Int
  $page: Int
  $translationType: VaildTranslationTypeEnumType
  $countryOrigin: VaildCountryOriginEnumType
) {
  shows(
    search: $search
    limit: $limit
    page: $page
    translationType: $translationType
    countryOrigin: $countryOrigin
  ) {
    edges {
      _id
      name
      availableEpisodes
      thumbnail
      genres
      score
    }
  }
}`;

const SHOW_DETAIL_GQL = `
query ($_id: String!) {
  show(_id: $_id) {
    _id
    name
    thumbnail
    description
    genres
    score
    availableEpisodesDetail
  }
}`;

const EPISODE_GQL = `
query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
  episode(
    showId: $showId
    translationType: $translationType
    episodeString: $episodeString
  ) {
    episodeString
    sourceUrls
  }
}`;

// ============================================
// DECRYPTION: AES-GCM
// ============================================
function decryptTobeParsed(tobeparsed) {
  try {
    const raw = Buffer.from(tobeparsed, 'base64');
    const keyStr = "P7K2RGbFgauVtmiS".split('').reverse().join('');
    const key    = crypto.createHash('sha256').update(keyStr).digest();
    const iv     = raw.slice(0, 12);
    const tag    = raw.slice(-16);
    const data   = raw.slice(12, -16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    console.error('[decryptTobeParsed] Failed:', e.message);
    return null;
  }
}

// ============================================
// SOURCE URL DECODER: XOR with 56
// ============================================
function decodeSourceUrl(encoded) {
  const clean = encoded.replace(/^--/, '');
  let result = '';
  for (let i = 0; i < clean.length; i += 2) {
    const hexByte = clean.slice(i, i + 2);
    const dec     = parseInt(hexByte, 16);
    if (isNaN(dec)) continue;
    const xored   = dec ^ 56;
    const octal   = xored.toString(8).padStart(3, '0');
    result += String.fromCharCode(parseInt(octal, 8));
  }
  return result;
}

// ============================================
// AXIOS WRAPPER: POST GraphQL + auto-decrypt
// ============================================
const ALLANIME_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Origin':     'https://allanime.to',
  'Referer':    'https://allmanga.to/',
  'Accept':     'application/json, text/plain, */*',
};

async function allanimePost(query, variables) {
  const { data } = await axios.post(
    ALLANIME_API,
    { variables: JSON.stringify(variables), query },
    { headers: { ...ALLANIME_HEADERS, 'Content-Type': 'application/json' } }
  );

  if (data?.data?.tobeparsed) {
    console.log('[allanimePost] Encrypted response detected — decrypting...');
    const decrypted = decryptTobeParsed(data.data.tobeparsed);
    if (decrypted) {
      console.log('[allanimePost] Decryption succeeded. Keys:', Object.keys(decrypted));
      return { data: { data: decrypted } };
    }
    console.warn('[allanimePost] Decryption failed, returning raw.');
  }
  return { data };
}

// ============================================
// ANILIST GRAPHQL QUERY
// ============================================
const ANILIST_QUERY = gql`
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      idMal
      title { romaji english native }
      description
      coverImage { large extraLarge }
      bannerImage
      genres
      averageScore
      popularity
      status
      episodes
      duration
      format
      startDate { year month day }
      endDate { year month day }
      synonyms
      studios { nodes { id name isAnimationStudio } }
      trailer { id site }
      externalLinks { url site }
      characters(sort: ROLE, perPage: 25) {
        edges {
          role
          node { id name { full } image { large } }
          voiceActors(language: JAPANESE) {
            id name { full } image { large } languageV2
          }
        }
      }
      recommendations(sort: RATING_DESC, perPage: 10) {
        nodes {
          mediaRecommendation {
            id title { romaji english } coverImage { large } averageScore format episodes
          }
        }
      }
      relations {
        edges {
          relationType
          node {
            id title { romaji english } coverImage { large } averageScore type format episodes
          }
        }
      }
    }
  }
`;

// ============================================
// EXTERNAL ID RULES
// ============================================
const EXTERNAL_ID_RULES = [
  { key: 'tmdb',        sites: ['themoviedb','tmdb'],      pattern: /themoviedb\.org\/tv\/(\d+)/ },
  { key: 'tmdbMovie',   sites: ['themoviedb','tmdb'],      pattern: /themoviedb\.org\/movie\/(\d+)/ },
  { key: 'tvdb',        sites: ['thetvdb','tvdb'],         pattern: /thetvdb\.com\/(?:series|derbyid)\/([^\/?#]+)/ },
  { key: 'mal',         sites: ['myanimelist','mal'],      pattern: /myanimelist\.net\/anime\/(\d+)/ },
  { key: 'anidb',       sites: ['anidb'],                  pattern: /anidb\.net\/(?:anime|a)[\/?]?(\d+)/ },
  { key: 'kitsu',       sites: ['kitsu'],                  pattern: /kitsu\.(?:io|app)\/anime\/([^\/?#]+)/ },
  { key: 'crunchyroll', sites: ['crunchyroll'],            pattern: /crunchyroll\.com\/series\/([^\/?#]+)/ },
  { key: 'netflix',     sites: ['netflix'],                pattern: /netflix\.com\/title\/(\d+)/ },
  { key: 'livechart',   sites: ['livechart'],              pattern: /livechart\.me\/anime\/(\d+)/ },
  { key: 'anisearch',   sites: ['anisearch'],              pattern: /anisearch\.(?:com|de)\/anime\/(\d+)/ },
  { key: 'notify',      sites: ['notify.moe','notify'],    pattern: /notify\.moe\/anime\/([^\/?#]+)/ },
  { key: 'hidive',      sites: ['hidive'],                 pattern: /hidive\.com\/tv\/([^\/?#]+)/ },
  { key: 'amazon',      sites: ['amazon'],                 pattern: /amazon\.(?:com|co\.jp)\/.*?(?:dp|gp\/product)\/([A-Z0-9]{10})/ },
];

function extractExternalIds(media) {
  const ids = {
    anilist: media.id    ? String(media.id)    : null,
    mal:     media.idMal ? String(media.idMal) : null,
  };
  for (const link of media.externalLinks || []) {
    const url  = link.url  || '';
    const site = (link.site || '').toLowerCase();
    for (const rule of EXTERNAL_ID_RULES) {
      if (ids[rule.key]) continue;
      const siteMatch = rule.sites.some(s => site.includes(s) || url.toLowerCase().includes(s));
      if (!siteMatch) continue;
      const m = url.match(rule.pattern);
      if (m) { ids[rule.key] = m[1]; break; }
    }
  }
  return Object.fromEntries(Object.entries(ids).filter(([, v]) => v != null));
}

function mapAnilistMedia(m) {
  return {
    id:             m.id,
    title:          m.title,
    description:    m.description,
    image:          m.coverImage?.extraLarge || m.coverImage?.large || "",
    cover:          m.bannerImage || "",
    rating:         m.averageScore,
    status:         m.status === "RELEASING" ? "Ongoing" : m.status === "FINISHED" ? "Completed" : m.status,
    totalEpisodes:  m.episodes,
    duration:       m.duration,
    releaseDate:    m.startDate?.year?.toString() || "",
    type:           m.format,
    genres:         m.genres || [],
    studios:        m.studios?.nodes?.map(s => s.name) || [],
    trailer:        m.trailer?.site === "youtube" ? {
                      id: m.trailer.id, site: "youtube",
                      thumbnail: `https://i.ytimg.com/vi/${m.trailer.id}/hqdefault.jpg`
                    } : null,
    externalIds:    extractExternalIds(m),
    externalLinks:  m.externalLinks || [],
    characters:     m.characters?.edges?.map(e => ({
                      id: e.node.id, name: e.node.name,
                      image: e.node.image?.large || "", role: e.role,
                      voiceActors: e.voiceActors?.map(va => ({
                        id: va.id, name: va.name,
                        image: va.image?.large || "", language: va.languageV2
                      })) || []
                    })) || [],
    recommendations: m.recommendations?.nodes?.filter(n => n.mediaRecommendation).map(n => ({
                      id: n.mediaRecommendation.id, title: n.mediaRecommendation.title,
                      image: n.mediaRecommendation.coverImage?.large || "",
                      rating: n.mediaRecommendation.averageScore,
                      type: n.mediaRecommendation.format,
                      episodes: n.mediaRecommendation.episodes,
                    })) || [],
    relations:       m.relations?.edges?.map(e => ({
                      id: e.node.id, title: e.node.title,
                      image: e.node.coverImage?.large || "",
                      rating: e.node.averageScore, type: e.node.type,
                      relationType: e.relationType, episodes: e.node.episodes,
                    })) || [],
  };
}

// ============================================
// TMDB HELPERS
// ============================================
async function searchTMDBByTitle(title) {
  try {
    const r = await axios.get(`${TMDB_API}/search/tv`, {
      params: { api_key: TMDB_KEY, query: title, page: 1 }, timeout: 8000
    });
    const results = r.data?.results || [];
    if (!results.length) return null;
    const best = results.reduce((a, b) => (b.vote_count ?? 0) > (a.vote_count ?? 0) ? b : a);
    return best.id?.toString() || null;
  } catch (e) { return null; }
}

async function fetchTMDBInfo(tmdbId) {
  try {
    const r = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY }, timeout: 10000
    });
    return {
      tmdbId,
      name:          r.data.name,
      overview:      r.data.overview,
      firstAirDate:  r.data.first_air_date,
      totalSeasons:  r.data.number_of_seasons,
      totalEpisodes: r.data.number_of_episodes,
      posterPath:    r.data.poster_path ? `https://image.tmdb.org/t/p/w500${r.data.poster_path}` : null,
      backdropPath:  r.data.backdrop_path ? `https://image.tmdb.org/t/p/original${r.data.backdrop_path}` : null,
      genres:        r.data.genres?.map(g => g.name) || [],
      rating:        r.data.vote_average,
      seasons:       (r.data.seasons || []).filter(s => s.season_number > 0).map(s => ({
                       seasonNumber: s.season_number, episodeCount: s.episode_count,
                       airDate: s.air_date, name: s.name,
                       poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
                     }))
    };
  } catch (e) { return null; }
}

async function buildTMDBLookup(tmdbId, targetYear) {
  const lookup = new Map();
  try {
    const seriesRes = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY }, timeout: 10000
    });
    const seasons = (seriesRes.data?.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0);

    let matchedSeason = null;
    if (targetYear) {
      matchedSeason = seasons.find(s => s.air_date && parseInt(s.air_date.substring(0, 4)) === targetYear)
        || seasons.find(s => s.air_date && Math.abs(parseInt(s.air_date.substring(0, 4)) - targetYear) === 1);
    }

    const seasonsToFetch = matchedSeason ? [matchedSeason] : seasons;
    let absoluteNumber = 1;

    for (const season of seasonsToFetch) {
      try {
        const seasonRes = await axios.get(`${TMDB_API}/tv/${tmdbId}/season/${season.season_number}`, {
          params: { api_key: TMDB_KEY }, timeout: 12000
        });
        for (const ep of seasonRes.data?.episodes || []) {
          lookup.set(absoluteNumber, {
            title:         ep.name        || null,
            overview:      ep.overview    || null,
            airDate:       ep.air_date    || null,
            aired:         ep.air_date ? new Date(ep.air_date) <= new Date() : null,
            rating:        ep.vote_average != null ? String(ep.vote_average) : null,
            thumbnail:     ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
            seasonNumber:  ep.season_number  ?? null,
            episodeNumber: ep.episode_number ?? null,
          });
          absoluteNumber++;
        }
      } catch (e) {
        console.warn(`[TMDB] Season ${season.season_number} failed:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[TMDB] buildTMDBLookup failed:', e.message);
  }
  return lookup;
}

// ============================================
// ANIMEYUBI / ANIMEPAHE HELPERS
// ============================================

const PAHE_HEADERS = {
  'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer':     'https://animepahe.ru/',
  'Accept':      'application/json, text/plain, */*',
};

const ANIMEYUBI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer':    'https://animeyubi.com/',
};

/**
 * Search AnimePahe by title.
 *
 * Strategy 1 — Direct AnimePahe API (most reliable):
 *   GET https://animepahe.ru/api?m=search&q=<title>
 *   Returns { data: [{ id, session, title, ... }] }
 *   The numeric `id` matches the animeyubi /pahe/:animeId endpoint.
 *
 * Strategy 2 — animeyubi search proxy (fallback):
 *   GET https://animeyubi.com/api/v4/pahe/search/?q=<title>
 *
 * Returns { id, session?, title } or null.
 */
async function searchPaheAnime(title) {
  // ── Strategy 1: Direct AnimePahe API ──────────────────────────────────
  try {
    console.log(`[searchPaheAnime] Trying AnimePahe direct API for: "${title}"`);
    const r = await axios.get('https://animepahe.ru/api', {
      params: { m: 'search', q: title },
      headers: PAHE_HEADERS,
      timeout: 10000,
    });

    const results = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    if (results.length) {
      console.log(`[searchPaheAnime] AnimePahe direct hit → id=${results[0].id} title="${results[0].title}"`);
      return results[0];   // { id (numeric), session, title, ... }
    }
    console.log('[searchPaheAnime] AnimePahe direct: no results');
  } catch (e) {
    console.warn('[searchPaheAnime] AnimePahe direct failed:', e.message);
  }

  // ── Strategy 2: animeyubi search proxy ────────────────────────────────
  for (const endpoint of [
    `https://animeyubi.com/api/v4/pahe/search/?q=${encodeURIComponent(title)}`,
    `https://animeyubi.com/api/v4/pahe/anime/?search=${encodeURIComponent(title)}`,
  ]) {
    try {
      console.log(`[searchPaheAnime] Trying animeyubi endpoint: ${endpoint}`);
      const r = await axios.get(endpoint, { headers: ANIMEYUBI_HEADERS, timeout: 10000 });
      const results = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.results || []);
      if (results.length) {
        console.log(`[searchPaheAnime] animeyubi hit → id=${results[0].id} title="${results[0].title}"`);
        return results[0];
      }
    } catch (e) {
      console.warn(`[searchPaheAnime] animeyubi endpoint failed (${endpoint}):`, e.message);
    }
  }

  return null;
}

async function fetchPaheAnime(animeId) {
  try {
    const r = await axios.get(`https://animeyubi.com/api/v4/pahe/anime/${animeId}/`, {
      headers: ANIMEYUBI_HEADERS,
      timeout: 10000,
    });
    return r.data;
  } catch (e) {
    console.error('[fetchPaheAnime]', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

async function fetchPaheEpisodeDetail(episodeId) {
  try {
    const r = await axios.get(`https://animeyubi.com/api/v4/pahe/episodes/${episodeId}/`, {
      headers: ANIMEYUBI_HEADERS,
      timeout: 10000,
    });
    return r.data;
  } catch (e) {
    console.error('[fetchPaheEpisodeDetail]', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

/**
 * Given an AnimePahe anime ID, fetch the full episode list and format it
 * in a shape consistent with AllanimeAPI episodes (for use in /anilist/:id).
 * Optionally merges TMDB metadata via tmdbLookup.
 */
async function fetchPaheEpisodesForAnilist(paheAnimeId, tmdbLookup = new Map()) {
  const anime = await fetchPaheAnime(paheAnimeId);
  if (!anime) return [];

  // The episode list may live directly on anime.episodes, or we pull from the first ep detail
  let allEpisodes = anime.episodes || [];

  if (!allEpisodes.length) {
    const firstEpId = anime.episodes?.[0]?.id;
    if (firstEpId) {
      const detail = await fetchPaheEpisodeDetail(firstEpId);
      allEpisodes = detail?.anime?.episodes || [];
    }
  }

  return allEpisodes.map((ep, idx) => {
    const epNum    = idx + 1;
    const meta     = tmdbLookup.get(epNum) || null;
    const episodeId = String(ep.id);

    return {
      episodeId,
      episode:   String(ep.episode ?? ep.title ?? epNum),
      type:      'sub',                     // pahe is primarily sub
      label:     `Episode ${ep.episode ?? epNum}`,
      videoUrl:  `http://localhost:3000/pahe-episode/${episodeId}`,
      ...(meta?.title         && { title:         meta.title }),
      ...(meta?.overview      && { overview:      meta.overview }),
      ...(meta?.airDate       && { airDate:        meta.airDate }),
      ...(meta?.aired  != null && { aired:         meta.aired }),
      ...(meta?.rating        && { rating:         meta.rating }),
      ...(meta?.thumbnail     && { thumbnail:      meta.thumbnail }),
      ...(meta?.seasonNumber  != null && { seasonNumber:  meta.seasonNumber }),
      ...(meta?.episodeNumber != null && { episodeNumber: meta.episodeNumber }),
    };
  });
}

// ============================================
// SHARED: fetch allanime episodes + merge TMDB
// ============================================
async function fetchAnimeWithEpisodes(animeId, anilistId = null) {
  const { data } = await allanimePost(SHOW_DETAIL_GQL, { _id: animeId });
  const show = data?.data?.show;
  if (!show) return null;

  let tmdbLookup = new Map();
  let tmdbInfo   = null;

  try {
    if (anilistId) {
      const anilistData = await request(ANILIST_API, ANILIST_QUERY, { id: parseInt(anilistId) });
      const media = anilistData?.Media;
      if (media) {
        const externalIds = extractExternalIds(media);
        let tmdbId = externalIds?.tmdb || null;
        if (!tmdbId) {
          const candidates = [media.title?.english, media.title?.romaji].filter(Boolean);
          for (const title of candidates) {
            tmdbId = await searchTMDBByTitle(title);
            if (tmdbId) break;
          }
        }
        if (tmdbId) {
          tmdbInfo   = await fetchTMDBInfo(tmdbId);
          tmdbLookup = await buildTMDBLookup(tmdbId, media.startDate?.year || null);
        }
      }
    }
  } catch (e) {
    console.warn('[TMDB merge] failed:', e.message);
  }

  const { availableEpisodesDetail, name, thumbnail, _id, description, genres, score } = show;
  const episodes = [];

  ['sub', 'dub', 'raw'].forEach(type => {
    (availableEpisodesDetail?.[type] || []).forEach(ep => {
      const episodeId = `${_id}&episode=${ep}&type=${type}`;
      const meta = tmdbLookup.get(Math.round(parseFloat(ep))) || null;
      episodes.push({
        episodeId,
        episode:  ep,
        type,
        label:    `${type} Episode ${ep}`,
        videoUrl: `http://localhost:3000/sources/${episodeId}`,
        ...(meta?.title         && { title:         meta.title }),
        ...(meta?.overview      && { overview:      meta.overview }),
        ...(meta?.airDate       && { airDate:        meta.airDate }),
        ...(meta?.aired   != null && { aired:        meta.aired }),
        ...(meta?.rating        && { rating:         meta.rating }),
        ...(meta?.thumbnail     && { thumbnail:      meta.thumbnail }),
        ...(meta?.seasonNumber  != null && { seasonNumber:  meta.seasonNumber }),
        ...(meta?.episodeNumber != null && { episodeNumber: meta.episodeNumber }),
      });
    });
  });

  episodes.sort((a, b) => parseFloat(a.episode) - parseFloat(b.episode));

  return {
    animeId:    _id,
    anilistId:  anilistId ? parseInt(anilistId) : null,
    name,
    thumbnail:  thumbnail?.startsWith('http') ? thumbnail : `https://wp.youtube-anime.com/aln.youtube-anime.com/${thumbnail}`,
    description: description || null,
    genres:     genres || [],
    score:      score  || null,
    tmdb:       tmdbInfo,
    total:      episodes.length,
    episodes
  };
}

// ============================================
// GET / - API docs
// ============================================
router.get('/', (req, res) => {
  res.json({
    name: "🎌 Anime Scraper API",
    version: "3.1.0",
    endpoints: [
      { method: "GET", path: "/recent",                                    description: "Browse latest anime list",                                              example: "/anime/animeyubi/recent?page=1&type=sub" },
      { method: "GET", path: "/search",                                    description: "Search anime by title",                                                 example: "/anime/animeyubi/search?q=naruto" },
      { method: "GET", path: "/details/:animeId",                          description: "Get anime + episodes (no TMDB meta)",                                   example: "/anime/animeyubi/details/ReooPAxPMsHM4KPMY" },
      { method: "GET", path: "/anilist/:anilistId?provider=allanime",      description: "AniList info + AllanimeAPI episodes + TMDB meta (default)",             example: "/anime/animeyubi/anilist/21?provider=allanime" },
      { method: "GET", path: "/anilist/:anilistId?provider=animepahe",     description: "AniList info + AnimePahe episodes + TMDB meta",                        example: "/anime/animeyubi/anilist/21?provider=animepahe" },
      { method: "GET", path: "/anilist/:anilistId?provider=animepahe&paheId=9973", description: "Skip search, use known AnimePahe ID directly",                example: "/anime/animeyubi/anilist/21?provider=animepahe&paheId=9973" },
      { method: "GET", path: "/sources/:episodeId",                        description: "Get all video sources for an AllanimeAPI episode",                      example: "/anime/animeyubi/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub" },
      { method: "GET", path: "/pahe/:animeId",                             description: "Get AnimePahe anime + episodes by AnimePahe anime ID",                 example: "/anime/animeyubi/pahe/9973" },
      { method: "GET", path: "/pahe-episode/:episodeId",                   description: "Get video links for an AnimePahe episode",                              example: "/anime/animeyubi/pahe-episode/12345" },
      { method: "GET", path: "/pahe-sources/:videoId",                     description: "Proxy download/stream link for an AnimePahe video",                    example: "/anime/animeyubi/pahe-sources/67890" },
      { method: "GET", path: "/tmdb/:tmdbId",                              description: "Get TMDB series info and seasons",                                      example: "/anime/animeyubi/tmdb/30983" },
    ],
  });
});

// ============================================
// GET /recent?page=1&type=sub
// ============================================
router.get('/recent', async (req, res) => {
  const { page = 1, type = 'sub' } = req.query;
  try {
    const { data } = await allanimePost(SEARCH_GQL, {
      translationType: type,
      countryOrigin: 'ALL',
      search: {},
      limit: 26,
      page: parseInt(page)
    });
    const animes = (data?.data?.shows?.edges || []).map(show => ({
      animeId:           show._id,
      title:             show.name,
      image:             show.thumbnail?.startsWith('http') ? show.thumbnail : `https://wp.youtube-anime.com/aln.youtube-anime.com/${show.thumbnail}`,
      genres:            show.genres || [],
      score:             show.score  || null,
      availableEpisodes: show.availableEpisodes || {},
      detailsUrl:        `http://localhost:3000/details/${show._id}`
    }));
    res.json({ page: parseInt(page), type, total: animes.length, animes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /search?q=naruto&page=1
// ============================================
router.get('/search', async (req, res) => {
  const { q = '', page = 1, type = 'sub' } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query param q', example: '/search?q=naruto' });
  try {
    const { data } = await allanimePost(SEARCH_GQL, {
      search: { sortBy: 'Name_ASC', allowAdult: false, query: q },
      limit: 26,
      page: parseInt(page)
    });
    const animes = (data?.data?.shows?.edges || []).map(show => ({
      animeId:           show._id,
      title:             show.name,
      image:             show.thumbnail?.startsWith('http') ? show.thumbnail : `https://wp.youtube-anime.com/aln.youtube-anime.com/${show.thumbnail}`,
      genres:            show.genres || [],
      score:             show.score  || null,
      availableEpisodes: show.availableEpisodes || {},
      detailsUrl:        `http://localhost:3000/details/${show._id}`
    }));
    res.json({ query: q, page: parseInt(page), type, total: animes.length, animes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /details/:animeId  (no TMDB, fast)
// ============================================
router.get('/details/:animeId', async (req, res) => {
  try {
    const result = await fetchAnimeWithEpisodes(req.params.animeId, null);
    if (!result) return res.status(404).json({ error: 'Anime not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /pahe/:animeId
// ============================================
router.get('/pahe/:animeId', async (req, res) => {
  const { animeId } = req.params;
  try {
    const anime = await fetchPaheAnime(animeId);
    if (!anime) return res.status(404).json({ error: 'Anime not found on pahe' });

    const firstEpId = anime.episodes?.[0]?.id;
    if (!firstEpId) return res.status(404).json({ error: 'No episodes found' });

    const detail = await fetchPaheEpisodeDetail(firstEpId);
    const allEpisodes = detail?.anime?.episodes || anime.episodes || [];

    const episodes = allEpisodes.map(ep => ({
      episodeId: ep.id,
      episode:   ep.title,
      videoUrl:  `http://localhost:3000/pahe-episode/${ep.id}`,
    }));

    res.json({
      animeId,
      title:         anime.title          || null,
      titleEnglish:  anime.title_english   || null,
      titleJapanese: anime.jp_title        || null,
      image:         anime.image           || null,
      type:          anime.type            || null,
      status:        anime.status          || null,
      score:         anime.score           || null,
      synopsis:      anime.synopsis        || null,
      total:         episodes.length,
      episodeList:   episodes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /pahe-episode/:episodeId
// ============================================
router.get('/pahe-episode/:episodeId', async (req, res) => {
  const { episodeId } = req.params;
  try {
    const data = await fetchPaheEpisodeDetail(episodeId);
    if (!data) return res.status(404).json({ error: 'Episode not found' });

    const videos = (data.videos || []).map(v => ({
      videoId:   v.id,
      title:     v.title   || null,
      videoType: v.video_type === 'hls' ? 'm3u8' : 'mp4',
      kwikUrl:   v.url     || null,
      streamUrl: `http://localhost:3000/pahe-sources/${v.id}`,
    }));

    res.json({
      episodeId,
      episode:  data.title || null,
      animeId:  data.anime?.id || null,
      next:     data.next     || null,
      previous: data.previous || null,
      videos,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /anilist/:anilistId?provider=allanime|animepahe
//
// ?provider=allanime  (default) → episodes from AllanimeAPI
// ?provider=animepahe           → episodes from AnimePahe
// ?paheId=9973                  → skip AnimePahe search, use ID directly
// ============================================
router.get('/anilist/:anilistId', async (req, res) => {
  const anilistId = parseInt(req.params.anilistId);
  if (!anilistId) return res.status(400).json({ error: 'Invalid AniList ID' });

  // ── Provider selection ──────────────────────────────────────────────────
  const provider = (req.query.provider || 'allanime').toLowerCase();
  const validProviders = ['allanime', 'animepahe'];
  if (!validProviders.includes(provider)) {
    return res.status(400).json({
      error: `Invalid provider "${provider}"`,
      validProviders,
      example: `/anilist/${anilistId}?provider=animepahe`,
    });
  }

  try {
    // ── 1. Always fetch AniList metadata ───────────────────────────────────
    const anilistData = await request(ANILIST_API, ANILIST_QUERY, { id: anilistId });
    const media = anilistData?.Media;
    if (!media) return res.status(404).json({ error: 'Not found on AniList' });

    const mapped      = mapAnilistMedia(media);
    const externalIds = mapped.externalIds;

    // ── 2. Always build TMDB lookup (shared between providers) ─────────────
    let tmdbId = externalIds?.tmdb || null;
    if (!tmdbId) {
      const candidates = [media.title?.english, media.title?.romaji].filter(Boolean);
      for (const title of candidates) {
        tmdbId = await searchTMDBByTitle(title);
        if (tmdbId) break;
      }
    }

    let tmdbInfo   = null;
    let tmdbLookup = new Map();

    if (tmdbId) {
      tmdbInfo   = await fetchTMDBInfo(tmdbId);
      tmdbLookup = await buildTMDBLookup(tmdbId, media.startDate?.year || null);
    }

    // ── 3a. Provider: animepahe ────────────────────────────────────────────
    if (provider === 'animepahe') {
      // Allow caller to pass a known pahe ID directly via ?paheId=9973
      let paheAnimeId = req.query.paheId || null;

      if (!paheAnimeId) {
        // Try to find it by searching with AniList titles
        const titleCandidates = [
          media.title?.english,
          media.title?.romaji,
          media.title?.native,
        ].filter(Boolean);

        for (const title of titleCandidates) {
          console.log(`[animepahe] Searching AnimePahe for: "${title}"`);
          const result = await searchPaheAnime(title);
          if (result?.id) {
            paheAnimeId = String(result.id);
            console.log(`[animepahe] Found AnimePahe ID: ${paheAnimeId}`);
            break;
          }
        }
      }

      if (!paheAnimeId) {
        return res.status(404).json({
          error:    'Anime not found on AnimePahe',
          hint:     'Supply ?paheId=<id> to use a known AnimePahe ID, e.g. /anilist/21?provider=animepahe&paheId=9973',
          provider: 'animepahe',
          anilistId,
        });
      }

      const episodes = await fetchPaheEpisodesForAnilist(paheAnimeId, tmdbLookup);

      return res.json({
        anilistId,
        provider:   'animepahe',
        paheAnimeId,
        name:       mapped.title?.english || mapped.title?.romaji,
        anilist:    mapped,
        tmdb:       tmdbInfo,
        total:      episodes.length,
        episodes,
      });
    }

    // ── 3b. Provider: allanime (default) ──────────────────────────────────
    const titleCandidates = [
      media.title?.english,
      media.title?.romaji,
      media.title?.native,
    ].filter(Boolean);

    let animeId   = null;
    let episodes  = [];

    for (const title of titleCandidates) {
      try {
        const { data: searchData } = await allanimePost(SEARCH_GQL, {
          search: { sortBy: 'Name_ASC', allowAdult: true, query: title },
          limit: 5,
          page: 1
        });
        const edges = searchData?.data?.shows?.edges || [];
        if (edges.length) { animeId = edges[0]._id; break; }
      } catch (e) { continue; }
    }

    if (animeId) {
      const animeInfo = await fetchAnimeWithEpisodes(animeId, null);
      if (animeInfo) {
        episodes = animeInfo.episodes.map(ep => {
          const meta = tmdbLookup.get(Math.round(parseFloat(ep.episode))) || null;
          return {
            ...ep,
            ...(meta?.title         && { title:         meta.title }),
            ...(meta?.overview      && { overview:      meta.overview }),
            ...(meta?.airDate       && { airDate:        meta.airDate }),
            ...(meta?.aired   != null && { aired:        meta.aired }),
            ...(meta?.rating        && { rating:         meta.rating }),
            ...(meta?.thumbnail     && { thumbnail:      meta.thumbnail }),
            ...(meta?.seasonNumber  != null && { seasonNumber:  meta.seasonNumber }),
            ...(meta?.episodeNumber != null && { episodeNumber: meta.episodeNumber }),
          };
        });
      }
    }

    return res.json({
      anilistId,
      provider:  'allanime',
      animeId:   animeId || null,
      name:      mapped.title?.english || mapped.title?.romaji,
      anilist:   mapped,
      tmdb:      tmdbInfo,
      total:     episodes.length,
      episodes,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /pahe-sources/:videoId
// ============================================
router.get('/pahe-sources/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const response = await axios.get(
      `https://animeyubi.com/api/v4/pahe/videos/${videoId}/proxy_download/`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://animeyubi.com/',
        },
        timeout: 10000,
      }
    );

    const data = response.data;

    if (typeof data === 'string' && data.trim().startsWith('#EXTM3U')) {
      return res.json({
        videoId,
        videos: [{
          quality:   'auto',
          source:    response.request?.res?.responseUrl ||
                     `https://animeyubi.com/api/v4/pahe/videos/${videoId}/proxy_download/`,
          videoType: 'm3u8',
          headers: { 'Origin': 'https://kwik.cx', 'Referer': 'https://kwik.cx/' },
          m3u8Content: data,
        }]
      });
    }

    const rawData = Array.isArray(data) ? data : (data.data || data.videos || [data]);
    const videos = rawData.map(v => ({
      quality:   v.quality || v.resolution || 'auto',
      source:    v.url || v.download || v.stream || v.file || v.src || null,
      videoType: (v.url || v.file || v.stream || '')?.includes('.m3u8') ? 'm3u8' : 'mp4',
      headers:   v.headers || {},
    })).filter(v => v.source);

    if (!videos.length) return res.status(404).json({ error: 'No video found' });
    res.json({ videoId, videos });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /sources/:episodeId
// ============================================
router.get('/sources/:episodeId', async (req, res) => {
  const raw = req.params.episodeId;
  console.log('\n========== /sources called ==========');
  console.log('Raw episodeId:', raw);

  const match = raw.match(/^(.+?)&episode=(.+?)&type=(.+)$/);
  if (!match) return res.status(400).json({
    error: 'Invalid episodeId format',
    expected: 'animeId&episode=1&type=sub',
    example: '/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub'
  });

  const [, animeId, episode, type] = match;
  console.log('Parsed → animeId:', animeId, '| episode:', episode, '| type:', type);

  try {
    console.log('Calling AllanimeAPI for episode sources...');
    const { data } = await allanimePost(EPISODE_GQL, {
      showId: animeId,
      episodeString: episode,
      translationType: type
    });

    console.log('Resolved data keys:', data ? Object.keys(data) : 'null');

    if (data?.errors) {
      console.log('⚠️  GraphQL errors:', JSON.stringify(data.errors));
      return res.status(500).json({ error: 'GraphQL error', details: data.errors });
    }

    let resolvedData = data?.data;
    if (resolvedData?.tobeparsed) {
      console.log('[sources] Encrypted data layer — decrypting...');
      const dec = decryptTobeParsed(resolvedData.tobeparsed);
      if (dec) resolvedData = dec;
    }

    const episodeData = resolvedData?.episode;

    if (!episodeData) {
      console.log('❌ episodeData is null/undefined');
      console.log('resolvedData keys:', resolvedData ? Object.keys(resolvedData) : 'null');
      return res.status(404).json({
        error: 'Episode not found',
        debug: {
          hint: 'The episode data could not be retrieved.',
          resolvedDataKeys: resolvedData ? Object.keys(resolvedData) : [],
        }
      });
    }

    const clockUrls = [];
    const videos    = [];

    episodeData.sourceUrls?.forEach(p => {
      console.log('Source:', p.sourceName, '|', p.sourceUrl?.substring(0, 60));
      if (SKIP_SOURCES.includes(p.sourceName)) return;

      if (p.sourceUrl.startsWith("--")) {
        let decoded = decodeSourceUrl(p.sourceUrl).replace("clock", "clock.json");
        if (decoded.startsWith("/")) decoded = `${ALLANIME_BASE}${decoded}`;
        clockUrls.push({ name: p.sourceName, url: decoded });
      } else if (!p.sourceUrl.startsWith("#")) {
        videos.push({ name: p.sourceName, source: p.sourceUrl, videoType: p.type !== "player" ? "iframe" : "mp4" });
      }
    });

    const clockResults = await Promise.all(
      clockUrls.map(async ({ name, url }) => {
        console.log('Fetching clock URL for', name, ':', url);
        try {
          const r = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
              'Referer': 'https://allanime.to/',
              'Origin':  'https://allanime.to',
            }
          });
          console.log('Clock result for', name, ':', JSON.stringify(r.data)?.substring(0, 200));
          return { name, data: r.data };
        } catch (e) {
          console.log('Clock fetch error for', name, ':', e.message);
          return { name, error: e.message };
        }
      })
    );

    clockResults.forEach(({ name, data: clockData }) => {
      if (!clockData?.links) return;
      clockData.links.forEach(v => {
        const src = v?.src ?? v?.link;
        if (!src) return;
        videos.push({
          name:      `${name} - ${new URL(src).hostname}`,
          source:    src,
          videoType: v.hls ? "m3u8" : "mp4",
          headers:   v.headers || {}
        });
      });
    });

    console.log('Final videos count:', videos.length);
    console.log('========== /sources done ==========\n');

    res.json({ animeId, episode, type, videos });

  } catch (err) {
    console.log('❌ CAUGHT ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /tmdb/:tmdbId
// ============================================
router.get('/tmdb/:tmdbId', async (req, res) => {
  const info = await fetchTMDBInfo(req.params.tmdbId);
  if (!info) return res.status(404).json({ error: 'TMDB series not found' });
  res.json(info);
});

// ============================================
// START
// ============================================
export default router;