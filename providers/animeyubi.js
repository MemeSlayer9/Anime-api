const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { request, gql } = require('graphql-request');

const app = express();
const router = express.Router();

app.use(cors());

// ============================================
// CONSTANTS
// ============================================
const DECODE_MAP = {
  "01":"9","08":"0","05":"=","0a":"2","0b":"3","0c":"4","07":"?","00":"8",
  "5c":"d","0f":"7","5e":"f","17":"/","54":"l","09":"1","48":"p","4f":"w",
  "0e":"6","5b":"c","5d":"e","0d":"5","53":"k","1e":"&","5a":"b","59":"a",
  "4a":"r","4c":"t","4e":"v","57":"o","51":"i"
};

function decodeSourceUrl(encoded) {
  let result = "";
  encoded.replace("--", "").match(/.{1,2}/g)?.forEach(s => {
    if (s in DECODE_MAP) result += DECODE_MAP[s];
  });
  return result;
}

const ALLANIME_BASE = "https://allanime.day";
const ALLANIME_API  = "https://api.allanime.day/allanimeapi";
const SKIP_SOURCES  = ["Ak", "Yt-mp4", "Vid-mp4", "Sl-mp4"];
const ANILIST_API   = "https://graphql.anilist.co";
const TMDB_API      = "https://api.themoviedb.org/3";
const TMDB_KEY      = process.env.TMDB_API_KEY || '699be86b7a4ca2c8bc77525cb4938dc0';

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
  { key: 'notify',      sites: ['notify.moe','notify'],   pattern: /notify\.moe\/anime\/([^\/?#]+)/ },
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
// SHARED: fetch allanime episodes + merge TMDB
// ============================================
async function fetchAnimeWithEpisodes(animeId, anilistId = null) {
  // 1. Fetch from AllanimeAPI
  const { data } = await axios.get(ALLANIME_API, {
    params: {
      variables: JSON.stringify({ _id: animeId }),
      extensions: JSON.stringify({ persistedQuery: { sha256Hash: "043448386c7a686bc2aabfbb6b80f6074e795d350df48015023b079527b0848a", version: 1 } })
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
      'Origin': 'https://allanime.to', 'Referer': 'https://allanime.to/',
    }
  });

  const show = data?.data?.show;
  if (!show) return null;

  // 2. TMDB lookup
  let tmdbLookup = new Map();
  let tmdbInfo   = null;
  let resolvedAnilistId = anilistId ? parseInt(anilistId) : null;

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

  // 3. Build episodes + merge TMDB meta
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
    anilistId:  resolvedAnilistId,
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
    version: "1.0.0",
    endpoints: [
      { method: "GET", path: "/anime/animeyubi/recent",             description: "Browse latest anime list",                        example: "http://localhost:3000/recent?page=1&type=sub" },
      { method: "GET", path: "/anime/animeyubi/search",             description: "Search anime by title",                           example: "http://localhost:3000/search?q=naruto" },
      { method: "GET", path: "/anime/animeyubi/details/:animeId",   description: "Get anime + episodes (no TMDB meta)",             example: "http://localhost:3000/details/ReooPAxPMsHM4KPMY" },
      { method: "GET", path: "/anime/animeyubi/anilist/:anilistId",  description: "Get AniList info + episodes + TMDB meta merged", example: "http://localhost:3000/anilist/21" },
      { method: "GET", path: "/anime/animeyubisources/:episodeId", description: "Get all video sources for an episode",            example: "http://localhost:3000/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub" },
      { method: "GET", path: "/anime/animeyubi/tmdb/:tmdbId",       description: "Get TMDB series info and seasons",                example: "http://localhost:3000/tmdb/30983" },
    ],
    usage: {
      step1: "GET /recent              → recent anime list",
      step2: "GET /search?q=title      → search anime",
      step3: "GET /anilist/:id         → full info + episodes + TMDB metadata",
      step4: "GET /details/:animeId    → episodes only (no TMDB)",
      step5: "GET /sources/:episodeId  → get video sources",
    },
    examples: {
      recent:  "/anime/animeyubi/recent?page=1&type=sub",
      search:  "/anime/animeyubi/search?q=naruto",
      anilist: "/anime/animeyubi/anilist/21",
      details: "/anime/animeyubi/details/ReooPAxPMsHM4KPMY",
      details: "/anime/animeyubi/details/ReooPAxPMsHM4KPMY",
      sources: "/anime/animeyubi/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub",
      tmdb:    "/anime/animeyubi/tmdb/30983",
    }
  });
});

// ============================================
// GET /recent?page=1&type=sub
// ============================================
router.get('/recent', async (req, res) => {
  const { page = 1, type = 'sub' } = req.query;
  try {
    const { data } = await axios.get(ALLANIME_API, {
      params: {
        variables: JSON.stringify({ translationType: type, countryOrigin: 'ALL', search: {}, limit: 26, page: parseInt(page) }),
        extensions: JSON.stringify({ persistedQuery: { sha256Hash: "a24c500a1b765c68ae1d8dd85174931f661c71369c89b92b88b75a725afc471c", version: 1 } })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
        'Origin': 'https://allanime.to', 'Referer': 'https://allanime.to/',
      }
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
    const { data } = await axios.get(ALLANIME_API, {
      params: {
        variables: JSON.stringify({ search: { sortBy: 'Name_ASC', allowAdult: false, query: q }, limit: 26, page: parseInt(page) }),
        extensions: JSON.stringify({ persistedQuery: { sha256Hash: "a24c500a1b765c68ae1d8dd85174931f661c71369c89b92b88b75a725afc471c", version: 1 } })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
        'Origin': 'https://allanime.to', 'Referer': 'https://allanime.to/',
      }
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
// GET /anilist/:anilistId
// Full AniList info + matched allanime episodes + TMDB metadata merged
// ============================================
router.get('/anilist/:anilistId', async (req, res) => {
  const anilistId = parseInt(req.params.anilistId);
  if (!anilistId) return res.status(400).json({ error: 'Invalid AniList ID' });

  try {
    // 1. Fetch AniList info
    const anilistData = await request(ANILIST_API, ANILIST_QUERY, { id: anilistId });
    const media = anilistData?.Media;
    if (!media) return res.status(404).json({ error: 'Not found on AniList' });

    const mapped      = mapAnilistMedia(media);
    const externalIds = mapped.externalIds;

    // 2. Resolve TMDB
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

    // 3. Find matching allanime show by title
    const titleCandidates = [media.title?.english, media.title?.romaji, media.title?.native].filter(Boolean);
    let animeId   = null;
    let episodes  = [];
    let animeInfo = null;

    for (const title of titleCandidates) {
      try {
        const { data: searchData } = await axios.get(ALLANIME_API, {
          params: {
            variables: JSON.stringify({ search: { sortBy: 'Name_ASC', allowAdult: true, query: title }, limit: 5, page: 1 }),
            extensions: JSON.stringify({ persistedQuery: { sha256Hash: "a24c500a1b765c68ae1d8dd85174931f661c71369c89b92b88b75a725afc471c", version: 1 } })
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
            'Origin': 'https://allanime.to', 'Referer': 'https://allanime.to/',
          }
        });
        const edges = searchData?.data?.shows?.edges || [];
        if (edges.length) { animeId = edges[0]._id; break; }
      } catch (e) { continue; }
    }

    // 4. Fetch episodes if animeId found
    if (animeId) {
      animeInfo = await fetchAnimeWithEpisodes(animeId, null);
      if (animeInfo) {
        // Re-merge TMDB into episodes
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

    res.json({
      anilistId,
      animeId:     animeId || null,
      name:        mapped.title?.english || mapped.title?.romaji,
      anilist:     mapped,
      tmdb:        tmdbInfo,
      total:       episodes.length,
      episodes,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /sources/:episodeId
// ============================================
router.get('/sources/:episodeId', async (req, res) => {
  const raw = req.params.episodeId;
  const match = raw.match(/^(.+?)&episode=(.+?)&type=(.+)$/);
  if (!match) return res.status(400).json({
    error: 'Invalid episodeId format',
    expected: 'animeId&episode=1&type=sub',
    example: '/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub'
  });

  const [, animeId, episode, type] = match;
  try {
    const { data } = await axios.get(ALLANIME_API, {
      params: {
        variables: JSON.stringify({ showId: animeId, episodeString: episode, translationType: type }),
        extensions: JSON.stringify({ persistedQuery: { sha256Hash: "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec", version: 1 } })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
        'Origin': 'https://allanime.to', 'Referer': 'https://allanime.to/',
      }
    });

    const episodeData = data?.data?.episode;
    if (!episodeData) return res.status(404).json({ error: 'Episode not found' });

    const clockUrls = [];
    const videos    = [];

    episodeData.sourceUrls?.forEach(p => {
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
        try {
          const r = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
              'Referer': 'https://allanime.to/', 'Origin': 'https://allanime.to',
            }
          });
          return { name, data: r.data };
        } catch (e) { return { name, error: e.message }; }
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

    res.json({ animeId, episode, type, videos });
  } catch (err) {
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
 


module.exports = router;
