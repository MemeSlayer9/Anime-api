import { request, gql } from 'graphql-request';
import axios from 'axios';

// ============================================
// CONSTANTS
// ============================================
const ANILIST_API = 'https://graphql.anilist.co';
const TMDB_API    = 'https://api.themoviedb.org/3';
const TMDB_KEY    = process.env.TMDB_API_KEY || '699be86b7a4ca2c8bc77525cb4938dc0';

// ============================================
// GraphQL QUERY STRINGS
// ============================================
export const SEARCH_GQL = `
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

export const SHOW_DETAIL_GQL = `
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

export const EPISODE_GQL = `
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

export const ANILIST_QUERY = gql`
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
  { key: 'tmdb',        sites: ['themoviedb', 'tmdb'],    pattern: /themoviedb\.org\/tv\/(\d+)/ },
  { key: 'tmdbMovie',   sites: ['themoviedb', 'tmdb'],    pattern: /themoviedb\.org\/movie\/(\d+)/ },
  { key: 'tvdb',        sites: ['thetvdb', 'tvdb'],       pattern: /thetvdb\.com\/(?:series|derbyid)\/([^\/?#]+)/ },
  { key: 'mal',         sites: ['myanimelist', 'mal'],    pattern: /myanimelist\.net\/anime\/(\d+)/ },
  { key: 'anidb',       sites: ['anidb'],                 pattern: /anidb\.net\/(?:anime|a)[\/?]?(\d+)/ },
  { key: 'kitsu',       sites: ['kitsu'],                 pattern: /kitsu\.(?:io|app)\/anime\/([^\/?#]+)/ },
  { key: 'crunchyroll', sites: ['crunchyroll'],           pattern: /crunchyroll\.com\/series\/([^\/?#]+)/ },
  { key: 'netflix',     sites: ['netflix'],               pattern: /netflix\.com\/title\/(\d+)/ },
  { key: 'livechart',   sites: ['livechart'],             pattern: /livechart\.me\/anime\/(\d+)/ },
  { key: 'anisearch',   sites: ['anisearch'],             pattern: /anisearch\.(?:com|de)\/anime\/(\d+)/ },
  { key: 'notify',      sites: ['notify.moe', 'notify'],  pattern: /notify\.moe\/anime\/([^\/?#]+)/ },
  { key: 'hidive',      sites: ['hidive'],                pattern: /hidive\.com\/tv\/([^\/?#]+)/ },
  { key: 'amazon',      sites: ['amazon'],                pattern: /amazon\.(?:com|co\.jp)\/.*?(?:dp|gp\/product)\/([A-Z0-9]{10})/ },
];

// ============================================
// EXTERNAL ID EXTRACTOR
// ============================================
export function extractExternalIds(media) {
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

// ============================================
// ANILIST MEDIA MAPPER
// ============================================
export function mapAnilistMedia(m) {
  return {
    id:             m.id,
    title:          m.title,
    description:    m.description,
    image:          m.coverImage?.extraLarge || m.coverImage?.large || '',
    cover:          m.bannerImage || '',
    rating:         m.averageScore,
    status:         m.status === 'RELEASING' ? 'Ongoing' : m.status === 'FINISHED' ? 'Completed' : m.status,
    totalEpisodes:  m.episodes,
    duration:       m.duration,
    releaseDate:    m.startDate?.year?.toString() || '',
    type:           m.format,
    genres:         m.genres || [],
    studios:        m.studios?.nodes?.map(s => s.name) || [],
    trailer:        m.trailer?.site === 'youtube' ? {
                      id: m.trailer.id, site: 'youtube',
                      thumbnail: `https://i.ytimg.com/vi/${m.trailer.id}/hqdefault.jpg`
                    } : null,
    externalIds:    extractExternalIds(m),
    externalLinks:  m.externalLinks || [],
    characters:     m.characters?.edges?.map(e => ({
                      id: e.node.id, name: e.node.name,
                      image: e.node.image?.large || '', role: e.role,
                      voiceActors: e.voiceActors?.map(va => ({
                        id: va.id, name: va.name,
                        image: va.image?.large || '', language: va.languageV2
                      })) || []
                    })) || [],
    recommendations: m.recommendations?.nodes?.filter(n => n.mediaRecommendation).map(n => ({
                      id: n.mediaRecommendation.id, title: n.mediaRecommendation.title,
                      image: n.mediaRecommendation.coverImage?.large || '',
                      rating: n.mediaRecommendation.averageScore,
                      type: n.mediaRecommendation.format,
                      episodes: n.mediaRecommendation.episodes,
                    })) || [],
    relations:       m.relations?.edges?.map(e => ({
                      id: e.node.id, title: e.node.title,
                      image: e.node.coverImage?.large || '',
                      rating: e.node.averageScore, type: e.node.type,
                      relationType: e.relationType, episodes: e.node.episodes,
                    })) || [],
  };
}

// ============================================
// ANILIST FETCHER
// ============================================
export async function fetchAnilistMedia(anilistId) {
  const data = await request(ANILIST_API, ANILIST_QUERY, { id: parseInt(anilistId) });
  return data?.Media || null;
}

// ============================================
// TMDB HELPERS
// ============================================
export async function searchTMDBByTitle(title) {
  try {
    const r = await axios.get(`${TMDB_API}/search/tv`, {
      params: { api_key: TMDB_KEY, query: title, page: 1 },
      timeout: 8000,
    });
    const results = r.data?.results || [];
    if (!results.length) return null;
    const best = results.reduce((a, b) => (b.vote_count ?? 0) > (a.vote_count ?? 0) ? b : a);
    return best.id?.toString() || null;
  } catch (e) {
    return null;
  }
}

export async function fetchTMDBInfo(tmdbId) {
  try {
    const r = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY },
      timeout: 10000,
    });
    return {
      tmdbId,
      name:          r.data.name,
      overview:      r.data.overview,
      firstAirDate:  r.data.first_air_date,
      totalSeasons:  r.data.number_of_seasons,
      totalEpisodes: r.data.number_of_episodes,
      posterPath:    r.data.poster_path  ? `https://image.tmdb.org/t/p/w500${r.data.poster_path}`        : null,
      backdropPath:  r.data.backdrop_path ? `https://image.tmdb.org/t/p/original${r.data.backdrop_path}` : null,
      genres:        r.data.genres?.map(g => g.name) || [],
      rating:        r.data.vote_average,
      seasons:       (r.data.seasons || []).filter(s => s.season_number > 0).map(s => ({
                       seasonNumber: s.season_number, episodeCount: s.episode_count,
                       airDate: s.air_date, name: s.name,
                       poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
                     })),
    };
  } catch (e) {
    return null;
  }
}

export async function buildTMDBLookup(tmdbId, targetYear) {
  const lookup = new Map();
  try {
    const seriesRes = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY },
      timeout: 10000,
    });
    const seasons = (seriesRes.data?.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0);

    let matchedSeason = null;
    if (targetYear) {
      matchedSeason =
        seasons.find(s => s.air_date && parseInt(s.air_date.substring(0, 4)) === targetYear) ||
        seasons.find(s => s.air_date && Math.abs(parseInt(s.air_date.substring(0, 4)) - targetYear) === 1);
    }

    const seasonsToFetch = matchedSeason ? [matchedSeason] : seasons;
    let absoluteNumber = 1;

    for (const season of seasonsToFetch) {
      try {
        const seasonRes = await axios.get(`${TMDB_API}/tv/${tmdbId}/season/${season.season_number}`, {
          params: { api_key: TMDB_KEY },
          timeout: 12000,
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
// COMBINED: resolve TMDB ID + build lookup
// from AniList media object
// ============================================
export async function resolveTMDB(media) {
  const externalIds = extractExternalIds(media);
  let tmdbId = externalIds?.tmdb || null;

  if (!tmdbId) {
    const candidates = [media.title?.english, media.title?.romaji].filter(Boolean);
    for (const title of candidates) {
      tmdbId = await searchTMDBByTitle(title);
      if (tmdbId) break;
    }
  }

  if (!tmdbId) return { tmdbId: null, tmdbInfo: null, tmdbLookup: new Map() };

  const [tmdbInfo, tmdbLookup] = await Promise.all([
    fetchTMDBInfo(tmdbId),
    buildTMDBLookup(tmdbId, media.startDate?.year || null),
  ]);

  return { tmdbId, tmdbInfo, tmdbLookup };
}