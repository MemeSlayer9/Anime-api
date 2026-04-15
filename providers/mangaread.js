const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { request, gql } = require('graphql-request');

const router = express.Router();
const ANILIST_API = 'https://graphql.anilist.co';

// GraphQL queries
const SEARCH_MANGA_BY_ID = gql`
  query ($id: Int) {
    Media(id: $id, type: MANGA) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      chapters
      volumes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

const SEARCH_MANGA_BY_TITLE = gql`
  query ($search: String) {
    Media(search: $search, type: MANGA) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      chapters
      volumes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

// Helper function to convert title to MangaRead slug
function generateMangaSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-')      // Replace spaces with hyphens
    .replace(/-+/g, '-')       // Replace multiple hyphens with single hyphen
    .trim();
}

// Helper function to try fetching chapters with different title variations
async function fetchChaptersFromMangaRead(titles) {
  for (const title of titles) {
    const slug = generateMangaSlug(title);
    if (!slug) continue;

    try {
      const url = `https://www.mangaread.org/manga/${slug}/`;
      const pageResponse = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 5000
      });

      const $ = cheerio.load(pageResponse.data);
      
      // Check if we got a valid manga page
      const mangaTitle = $('.post-title h1').first().text().trim() || 
                        $('h1').first().text().trim();
      
      if (!mangaTitle) continue;
      
      // Extract chapters
      const chapters = [];
      $('.wp-manga-chapter').each((index, element) => {
        const $chapter = $(element);
        const link = $chapter.find('a').attr('href');
        const title = $chapter.find('a').text().trim();
        const releaseDate = $chapter.find('.chapter-release-date i').text().trim();
        
        if (link && title) {
          let chapterId = null;
          try {
            const urlPath = new URL(link).pathname;
            const match = urlPath.match(/\/manga\/(.+?\/.+?)\/$/);
            if (match) {
              chapterId = match[1];
            }
          } catch (e) {
            console.error('Failed to parse chapter ID:', e);
          }
          
          chapters.push({
            index: index + 1,
            chapterId: chapterId,
            title: title,
            url: link,
            releaseDate: releaseDate || null
          });
        }
      });

      if (chapters.length > 0) {
        return {
          success: true,
          mangaReadId: slug,
          mangaReadTitle: mangaTitle,
          chapters: chapters
        };
      }

    } catch (error) {
      // Continue to next title variant
      continue;
    }
  }

  return { success: false, chapters: [] };
}

// Scrape latest chapters from homepage with load more support
router.get('/latest-chapters', async (req, res) => {
  try {
    const loadAll = req.query.loadAll === 'true';
    
    let allManga = [];
    let currentPage = 1;
    let hasMore = true;

    // If loadAll is true, fetch all pages
    if (loadAll) {
      while (hasMore && currentPage <= 10) { // Limit to 10 pages for safety
        console.log(`Fetching page ${currentPage}...`);
        
        const pageData = await fetchPage(currentPage);
        
        if (pageData.manga.length === 0) {
          hasMore = false;
        } else {
          allManga = allManga.concat(pageData.manga);
          currentPage++;
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      return res.json({
        success: true,
        source: 'MangaRead Homepage (All Pages)',
        url: 'https://www.mangaread.org/',
        totalPages: currentPage - 1,
        totalManga: allManga.length,
        manga: allManga
      });
    }

    // Default: fetch only first page
    const pageData = await fetchPage(1);
    
    res.json({
      success: true,
      source: 'MangaRead Homepage',
      url: 'https://www.mangaread.org/',
      totalManga: pageData.manga.length,
      manga: pageData.manga
    });

  } catch (error) {
    console.error('MangaRead homepage scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scrape latest chapters from MangaRead'
    });
  }
});

// Helper function to fetch a specific page
async function fetchPage(pageNum) {
  const url = pageNum === 1 
    ? 'https://www.mangaread.org/' 
    : `https://www.mangaread.org/page/${pageNum}/`;
  
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);
  const manga = [];

  $('.page-item-detail').each((index, element) => {
    const $item = $(element);
    
    const mangaLink = $item.find('.item-thumb a').attr('href');
    const mangaTitle = $item.find('.post-title h3 a').text().trim();
    
    // Get cover image and force replace to 193x278
    let coverImage = $item.find('.item-thumb img').attr('data-src') || 
                     $item.find('.item-thumb img').attr('src');
    
    // Force replace any dimension with 193x278
    if (coverImage) {
      coverImage = coverImage.replace(/-110x150/g, '-193x278')
                             .replace(/-175x238/g, '-193x278')
                             .replace(/-350x476/g, '-193x278');
    }
    
    const ratingText = $item.find('.post-total-rating .score').text().trim();
    const rating = ratingText ? parseFloat(ratingText) : null;
    
    let mangaId = null;
    if (mangaLink) {
      try {
        const urlPath = new URL(mangaLink).pathname;
        const match = urlPath.match(/\/manga\/(.+?)\/?$/);
        if (match) {
          mangaId = match[1];
        }
      } catch (e) {
        console.error('Failed to parse manga ID:', e);
      }
    }
    
    const chapters = [];
    $item.find('.chapter-item').each((chIndex, chElement) => {
      const $chapter = $(chElement);
      const chapterLink = $chapter.find('.chapter a').attr('href');
      const chapterTitle = $chapter.find('.chapter a').text().trim();
      const releaseDate = $chapter.find('.post-on').text().trim();
      
      if (chapterLink && chapterTitle) {
        let chapterId = null;
        try {
          const urlPath = new URL(chapterLink).pathname;
          const match = urlPath.match(/\/manga\/(.+?\/.+?)\/?$/);
          if (match) {
            chapterId = match[1];
          }
        } catch (e) {
          console.error('Failed to parse chapter ID:', e);
        }
        
        chapters.push({
          title: chapterTitle,
          chapterId: chapterId,
          url: chapterLink,
          releaseDate: releaseDate || null
        });
      }
    });
    
    if (mangaTitle && mangaLink) {
      manga.push({
        index: index + 1,
        mangaId: mangaId,
        title: mangaTitle,
        url: mangaLink,
        coverImage: coverImage,
        rating: rating,
        latestChapters: chapters
      });
    }
  });

  return { manga };
}

  
// Helper function to fetch a specific page
async function fetchPage(pageNum) {
  const url = pageNum === 1 
    ? 'https://www.mangaread.org/' 
    : `https://www.mangaread.org/page/${pageNum}/`;
  
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);
  const manga = [];

  $('.page-item-detail').each((index, element) => {
    const $item = $(element);
    
    const mangaLink = $item.find('.item-thumb a').attr('href');
    const mangaTitle = $item.find('.post-title h3 a').text().trim();
    
    // Get higher resolution image from srcset
    const coverImageSrcset = $item.find('.item-thumb img').attr('srcset');
    let coverImage = $item.find('.item-thumb img').attr('src');
    
    // Parse srcset to get the highest resolution image
    if (coverImageSrcset) {
      const srcsetParts = coverImageSrcset.split(',').map(part => part.trim());
      // Get the last (highest resolution) image from srcset
      if (srcsetParts.length > 0) {
        const highestRes = srcsetParts[srcsetParts.length - 1];
        coverImage = highestRes.split(' ')[0];
      }
    }
    
    // Additional fallback: replace dimensions in URL
    if (coverImage) {
      // Replace 110x150 with 193x278
      coverImage = coverImage.replace(/(-\d+x\d+)(\.webp|\.jpg|\.jpeg|\.png)/i, '-193x278$2');
    }
    
    const ratingText = $item.find('.post-total-rating .score').text().trim();
    const rating = ratingText ? parseFloat(ratingText) : null;
    
    let mangaId = null;
    if (mangaLink) {
      try {
        const urlPath = new URL(mangaLink).pathname;
        const match = urlPath.match(/\/manga\/(.+?)\/?$/);
        if (match) {
          mangaId = match[1];
        }
      } catch (e) {
        console.error('Failed to parse manga ID:', e);
      }
    }
    
    const chapters = [];
    $item.find('.chapter-item').each((chIndex, chElement) => {
      const $chapter = $(chElement);
      const chapterLink = $chapter.find('.chapter a').attr('href');
      const chapterTitle = $chapter.find('.chapter a').text().trim();
      const releaseDate = $chapter.find('.post-on').text().trim();
      
      if (chapterLink && chapterTitle) {
        let chapterId = null;
        try {
          const urlPath = new URL(chapterLink).pathname;
          const match = urlPath.match(/\/manga\/(.+?\/.+?)\/?$/);
          if (match) {
            chapterId = match[1];
          }
        } catch (e) {
          console.error('Failed to parse chapter ID:', e);
        }
        
        chapters.push({
          title: chapterTitle,
          chapterId: chapterId,
          url: chapterLink,
          releaseDate: releaseDate || null
        });
      }
    });
    
    if (mangaTitle && mangaLink) {
      manga.push({
        index: index + 1,
        mangaId: mangaId,
        title: mangaTitle,
        url: mangaLink,
        coverImage: coverImage,
        rating: rating,
        latestChapters: chapters
      });
    }
  });

  return { manga };
}

 
// Helper function to fetch a specific page
async function fetchPage(pageNum) {
  const url = pageNum === 1 
    ? 'https://www.mangaread.org/' 
    : `https://www.mangaread.org/page/${pageNum}/`;
  
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);
  const manga = [];

  $('.page-item-detail').each((index, element) => {
    const $item = $(element);
    
    const mangaLink = $item.find('.item-thumb a').attr('href');
    const mangaTitle = $item.find('.post-title h3 a').text().trim();
    
    // Get higher resolution image from srcset
    const coverImageSrcset = $item.find('.item-thumb img').attr('srcset');
    let coverImage = $item.find('.item-thumb img').attr('src');
    
    // Parse srcset to get the highest resolution image (193x278 or similar)
    if (coverImageSrcset) {
      const srcsetParts = coverImageSrcset.split(',').map(part => part.trim());
      // Look for medium resolution images (175w or higher)
      const mediumRes = srcsetParts.find(part => part.includes('175x238') || part.includes('193x278'));
      if (mediumRes) {
        coverImage = mediumRes.split(' ')[0];
      }
    }
    
    // Fallback: try to construct 193x278 URL from the base image
    if (coverImage && coverImage.includes('-110x150.')) {
      coverImage = coverImage.replace('-110x150.', '-193x278.');
    } else if (coverImage && coverImage.includes('-110x150')) {
      coverImage = coverImage.replace('-110x150', '-193x278');
    }
    
    const ratingText = $item.find('.post-total-rating .score').text().trim();
    const rating = ratingText ? parseFloat(ratingText) : null;
    
    let mangaId = null;
    if (mangaLink) {
      try {
        const urlPath = new URL(mangaLink).pathname;
        const match = urlPath.match(/\/manga\/(.+?)\/?$/);
        if (match) {
          mangaId = match[1];
        }
      } catch (e) {
        console.error('Failed to parse manga ID:', e);
      }
    }
    
    const chapters = [];
    $item.find('.chapter-item').each((chIndex, chElement) => {
      const $chapter = $(chElement);
      const chapterLink = $chapter.find('.chapter a').attr('href');
      const chapterTitle = $chapter.find('.chapter a').text().trim();
      const releaseDate = $chapter.find('.post-on').text().trim();
      
      if (chapterLink && chapterTitle) {
        let chapterId = null;
        try {
          const urlPath = new URL(chapterLink).pathname;
          const match = urlPath.match(/\/manga\/(.+?\/.+?)\/?$/);
          if (match) {
            chapterId = match[1];
          }
        } catch (e) {
          console.error('Failed to parse chapter ID:', e);
        }
        
        chapters.push({
          title: chapterTitle,
          chapterId: chapterId,
          url: chapterLink,
          releaseDate: releaseDate || null
        });
      }
    });
    
    if (mangaTitle && mangaLink) {
      manga.push({
        index: index + 1,
        mangaId: mangaId,
        title: mangaTitle,
        url: mangaLink,
        coverImage: coverImage,
        rating: rating,
        latestChapters: chapters
      });
    }
  });

  return { manga };
}

 
// Helper function to fetch a specific page
async function fetchPage(pageNum) {
  const url = pageNum === 1 
    ? 'https://www.mangaread.org/' 
    : `https://www.mangaread.org/page/${pageNum}/`;
  
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);
  const manga = [];

  $('.page-item-detail').each((index, element) => {
    const $item = $(element);
    
    const mangaLink = $item.find('.item-thumb a').attr('href');
    const mangaTitle = $item.find('.post-title h3 a').text().trim();
    const coverImage = $item.find('.item-thumb img').attr('src');
    const coverImageSrcset = $item.find('.item-thumb img').attr('srcset');
    
    const ratingText = $item.find('.post-total-rating .score').text().trim();
    const rating = ratingText ? parseFloat(ratingText) : null;
    
    let mangaId = null;
    if (mangaLink) {
      try {
        const urlPath = new URL(mangaLink).pathname;
        const match = urlPath.match(/\/manga\/(.+?)\/?$/);
        if (match) {
          mangaId = match[1];
        }
      } catch (e) {
        console.error('Failed to parse manga ID:', e);
      }
    }
    
    const chapters = [];
    $item.find('.chapter-item').each((chIndex, chElement) => {
      const $chapter = $(chElement);
      const chapterLink = $chapter.find('.chapter a').attr('href');
      const chapterTitle = $chapter.find('.chapter a').text().trim();
      const releaseDate = $chapter.find('.post-on').text().trim();
      
      if (chapterLink && chapterTitle) {
        let chapterId = null;
        try {
          const urlPath = new URL(chapterLink).pathname;
          const match = urlPath.match(/\/manga\/(.+?\/.+?)\/?$/);
          if (match) {
            chapterId = match[1];
          }
        } catch (e) {
          console.error('Failed to parse chapter ID:', e);
        }
        
        chapters.push({
          title: chapterTitle,
          chapterId: chapterId,
          url: chapterLink,
          releaseDate: releaseDate || null
        });
      }
    });
    
    if (mangaTitle && mangaLink) {
      manga.push({
        index: index + 1,
        mangaId: mangaId,
        title: mangaTitle,
        url: mangaLink,
        coverImage: coverImage,
         rating: rating,
        latestChapters: chapters
      });
    }
  });

  return { manga };
}

 
// AniList route - Get manga info by AniList ID with chapters
router.get('/anilist/:anilistId', async (req, res) => {
  try {
    const { anilistId } = req.params;
    const id = parseInt(anilistId, 10);
    
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Valid AniList ID is required',
        example: '/manga/mangaread/anilist/30013'
      });
    }

    // Query AniList API
    const data = await request(ANILIST_API, SEARCH_MANGA_BY_ID, { id });
    
    if (!data || !data.Media) {
      return res.status(404).json({
        success: false,
        error: 'Manga not found on AniList'
      });
    }

    const manga = data.Media;

    // Prepare response object
    const response = {
      success: true,
      source: 'AniList',
      manga: {
        id: manga.id,
        title: manga.title,
        description: manga.description,
        coverImage: manga.coverImage,
        bannerImage: manga.bannerImage,
        genres: manga.genres,
        tags: manga.tags?.map(tag => tag.name) || [],
        averageScore: manga.averageScore,
        popularity: manga.popularity,
        status: manga.status,
        totalChapters: manga.chapters,
        volumes: manga.volumes,
        startDate: manga.startDate,
        endDate: manga.endDate,
        synonyms: manga.synonyms,
        siteUrl: manga.siteUrl
      }
    };

    // Try to fetch chapters from MangaRead using various title formats
    const titlesToTry = [
      manga.title.english,
      manga.title.romaji,
      ...(manga.synonyms || [])
    ].filter(Boolean);

    const chapterData = await fetchChaptersFromMangaRead(titlesToTry);

    if (chapterData.success) {
      response.manga.mangaReadId = chapterData.mangaReadId;
      response.manga.mangaReadTitle = chapterData.mangaReadTitle;
      response.manga.availableChapters = chapterData.chapters.length;
      response.manga.chapters = chapterData.chapters;
    } else {
      response.manga.availableChapters = 0;
      response.manga.chapters = [];
      response.manga.note = 'Chapters not found on MangaRead';
    }

    res.json(response);

  } catch (error) {
    console.error('AniList API error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch manga from AniList'
    });
  }
});

// Scrape manga chapter images using path parameters (MUST BE FIRST - more specific route)
router.get('/read/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://www.mangaread.org/manga/${mangaId}/${chapterId}/`;
    
    if (!mangaId || !chapterId) {
      return res.status(400).json({
        success: false,
        error: 'Manga ID and Chapter ID parameters are required',
        example: '/manga/mangaread/read/one-piece/chapter-1164'
      });
    }
    
    // Fetch the page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Load HTML into cheerio
    const $ = cheerio.load(response.data);
    
    // Extract manga images
    const images = [];
    $('.wp-manga-chapter-img').each((index, element) => {
      const imgSrc = $(element).attr('src')?.trim() || $(element).attr('data-src')?.trim();
      if (imgSrc) {
        images.push({
          index: index + 1,
          url: imgSrc,
          alt: $(element).attr('alt') || `Page ${index + 1}`
        });
      }
    });

    // Extract chapter info
    const chapterTitle = $('h1').first().text().trim();
    
    res.json({
      success: true,
      url: url,
      chapterTitle: chapterTitle || 'Chapter',
      totalImages: images.length,
      images: images
    });

  } catch (error) {
    console.error('MangaRead scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scrape the manga page'
    });
  }
});

// Scrape manga chapter list using path parameters
router.get('/read/:mangaId', async (req, res) => {
  try {
    const { mangaId } = req.params;
    const url = `https://www.mangaread.org/manga/${mangaId}/`;
    
    if (!mangaId) {
      return res.status(400).json({
        success: false,
        error: 'Manga ID parameter is required',
        example: '/manga/mangaread/read/one-piece'
      });
    }
    
    // Fetch the page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Load HTML into cheerio
    const $ = cheerio.load(response.data);
    
    // Extract manga info
    const mangaTitle = $('.post-title h1').first().text().trim() || 
                       $('h1').first().text().trim();
    
    // Extract chapters
    const chapters = [];
    $('.wp-manga-chapter').each((index, element) => {
      const $chapter = $(element);
      const link = $chapter.find('a').attr('href');
      const title = $chapter.find('a').text().trim();
      const releaseDate = $chapter.find('.chapter-release-date i').text().trim();
      
      if (link && title) {
        // Extract chapterId from URL
        // Example: https://www.mangaread.org/manga/one-piece/chapter-1164/ -> one-piece/chapter-1164
        let chapterId = null;
        try {
          const urlPath = new URL(link).pathname;
          const match = urlPath.match(/\/manga\/(.+?\/.+?)\/$/);
          if (match) {
            chapterId = match[1];
          }
        } catch (e) {
          console.error('Failed to parse chapter ID:', e);
        }
        
        chapters.push({
          index: index + 1,
          chapterId: chapterId,
          title: title,
          url: link,
          releaseDate: releaseDate || null
        });
      }
    });

    res.json({
      success: true,
      url: url,
      mangaTitle: mangaTitle || 'Unknown Manga',
      totalChapters: chapters.length,
      chapters: chapters
    });

  } catch (error) {
    console.error('MangaRead chapter list scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scrape the manga chapter list'
    });
  }
});

// Download chapter as ZIP
router.get('/download-chapter/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://www.mangaread.org/manga/${mangaId}/${chapterId}/`;
    
    if (!mangaId || !chapterId) {
      return res.status(400).json({
        success: false,
        error: 'Manga ID and Chapter ID parameters are required',
        example: '/manga/mangaread/download-chapter/one-piece/chapter-1164'
      });
    }
    
    // Fetch the page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Load HTML into cheerio
    const $ = cheerio.load(response.data);
    
    // Extract manga images
    const images = [];
    $('.wp-manga-chapter-img').each((index, element) => {
      const imgSrc = $(element).attr('src')?.trim() || $(element).attr('data-src')?.trim();
      if (imgSrc) {
        images.push({
          index: index + 1,
          url: imgSrc
        });
      }
    });

    if (images.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No images found in chapter'
      });
    }

    // Extract chapter info
    const chapterTitle = $('h1').first().text().trim() || chapterId;
    
    // Set response headers for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${mangaId}-${chapterId}.zip"`);

    // Create archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Handle archive errors
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      res.status(500).json({
        success: false,
        error: 'Failed to create archive'
      });
    });

    // Pipe archive to response
    archive.pipe(res);

    // Download and add each image to the archive
    for (const image of images) {
      try {
        const imageResponse = await axios.get(image.url, {
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.mangaread.org/'
          }
        });

        // Get file extension from URL or content-type
        let ext = '.jpg';
        const urlExt = image.url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
        if (urlExt) {
          ext = urlExt[1].toLowerCase();
        }

        // Add image to archive with padded index
        const paddedIndex = String(image.index).padStart(3, '0');
        archive.append(imageResponse.data, { name: `${paddedIndex}.${ext}` });
      } catch (err) {
        console.error(`Failed to download image ${image.index}:`, err.message);
      }
    }

    // Finalize archive
    await archive.finalize();

  } catch (error) {
    console.error('MangaRead download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        message: 'Failed to download chapter'
      });
    }
  }
});

// Download multiple chapters as ZIP
// NOTE: chapterIds must be URL-encoded when making requests
// Example: one-piece/chapter-1164,one-piece/chapter-1163 becomes
//          one-piece%2Fchapter-1164%2Cone-piece%2Fchapter-1163
router.get('/download-multiple-chapters/:chapterIds', async (req, res) => {
  try {
    const { chapterIds } = req.params;
    const folderName = req.query.folderName || 'manga-chapters';
    
    if (!chapterIds) {
      return res.status(400).json({
        success: false,
        error: 'Chapter IDs parameter is required',
        example: '/manga/mangaread/download-multiple-chapters/one-piece%2Fchapter-1164%2Cone-piece%2Fchapter-1163?folderName=One-Piece',
        note: 'chapterIds must be URL-encoded (/ becomes %2F, comma becomes %2C)'
      });
    }

    // Parse chapter IDs (format: mangaId/chapterId,mangaId/chapterId)
    const chapters = chapterIds.split(',').map(id => {
      const parts = id.trim().split('/');
      if (parts.length >= 2) {
        return {
          mangaId: parts[0],
          chapterId: parts.slice(1).join('/')
        };
      }
      return null;
    }).filter(Boolean);

    if (chapters.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid chapter IDs format',
        example: 'one-piece%2Fchapter-1164%2Cone-piece%2Fchapter-1163'
      });
    }

    // Set response headers for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);

    // Create archive
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Failed to create archive'
        });
      }
    });

    // Pipe archive to response
    archive.pipe(res);

    // Process each chapter
    for (const chapter of chapters) {
      try {
        const url = `https://www.mangaread.org/manga/${chapter.mangaId}/${chapter.chapterId}/`;
        
        // Fetch the page
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        // Load HTML into cheerio
        const $ = cheerio.load(response.data);
        
        // Extract manga images
        const images = [];
        $('.wp-manga-chapter-img').each((index, element) => {
          const imgSrc = $(element).attr('src')?.trim() || $(element).attr('data-src')?.trim();
          if (imgSrc) {
            images.push({
              index: index + 1,
              url: imgSrc
            });
          }
        });

        // Create folder name for this chapter
        const chapterFolderName = `${chapter.chapterId}`;

        // Download and add each image to the archive
        for (const image of images) {
          try {
            const imageResponse = await axios.get(image.url, {
              responseType: 'stream',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.mangaread.org/'
              }
            });

            // Get file extension
            let ext = 'jpg';
            const urlExt = image.url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
            if (urlExt) {
              ext = urlExt[1].toLowerCase();
            }

            // Add image to archive with chapter folder
            const paddedIndex = String(image.index).padStart(3, '0');
            archive.append(imageResponse.data, { 
              name: `${chapterFolderName}/${paddedIndex}.${ext}` 
            });
          } catch (err) {
            console.error(`Failed to download image ${image.index} from ${chapter.chapterId}:`, err.message);
          }
        }

        console.log(`Processed ${chapter.chapterId}: ${images.length} images`);

      } catch (err) {
        console.error(`Failed to process chapter ${chapter.chapterId}:`, err.message);
      }
    }

    // Finalize archive
    await archive.finalize();

  } catch (error) {
    console.error('MangaRead multiple download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        message: 'Failed to download chapters'
      });
    }
  }
});

// Image proxy to handle CORS
router.get('/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
      return res.status(400).json({ 
        success: false,
        error: 'Image URL parameter is required' 
      });
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.mangaread.org/'
      }
    });

    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.send(response.data);

  } catch (error) {
    console.error('MangaRead image proxy error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch image' 
    });
  }
});

// Provider info endpoint
router.get('/', (req, res) => {
  res.json({
    provider: 'MangaRead',
    version: '1.0.0',
    baseUrl: 'https://www.mangaread.org',
    endpoints: [
      {
        path: '/latest-chapters',
        method: 'GET',
        description: 'Scrape latest manga chapters from MangaRead homepage',
        parameters: {},
        example: '/manga/mangaread/latest-chapters?loadAll=true'
      },
      {
        path: '/anilist/:anilistId',
        method: 'GET',
        description: 'Get manga information from AniList by ID with optional chapters from MangaRead',
        parameters: {
          anilistId: 'AniList manga ID (required)',
          mangaId: 'MangaRead manga ID (optional, query parameter)'
        },
        example: '/manga/mangaread/anilist/30013?mangaId=one-piece'
      },
      {
        path: '/read/:mangaId',
        method: 'GET',
        description: 'Scrape manga chapter list',
        parameters: {
          mangaId: 'Manga identifier (required)'
        },
        example: '/manga/mangaread/read/one-piece'
      },
      {
        path: '/read/:mangaId/:chapterId',
        method: 'GET',
        description: 'Scrape manga chapter images',
        parameters: {
          mangaId: 'Manga identifier (required)',
          chapterId: 'Chapter identifier (required)'
        },
        example: '/manga/mangaread/read/one-piece/chapter-1164'
      },
      {
        path: '/download-chapter/:mangaId/:chapterId',
        method: 'GET',
        description: 'Download manga chapter as ZIP file',
        parameters: {
          mangaId: 'Manga identifier (required)',
          chapterId: 'Chapter identifier (required)'
        },
        example: '/manga/mangaread/download-chapter/one-piece/chapter-1164'
      },
      {
        path: '/download-multiple-chapters/:chapterIds',
        method: 'GET',
        description: 'Download multiple manga chapters as ZIP file',
        parameters: {
          chapterIds: 'Comma-separated chapter IDs in format mangaId/chapterId (required, must be URL-encoded)',
          folderName: 'ZIP file name (optional, default: manga-chapters)'
        },
        example: '/manga/mangaread/download-multiple-chapters/one-piece%2Fchapter-1164%2Cone-piece%2Fchapter-1163?folderName=One-Piece'
      }
    ]
  });
});

module.exports = router;