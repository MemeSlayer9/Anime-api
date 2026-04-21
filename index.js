import 'dotenv/config';

import express from 'express';
import cors from 'cors';

import animeyubiProvider from './providers/Anime/animeyubi.js';
import kissanimeProvider from './providers/Anime/kissanime.js';
import anime123Provider  from './providers/Anime/123Anime.js';
import animedaoProvider  from './providers/Anime/animedao.js';
import auth from './middleware/auth.js';
import supabase from './supabaseClient.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    message: 'Anime Scraper API',
    version: '1.2.0',
    providers: {
      animeyubi:  { base: '/anime/animeyubi' },
      kissanime:  { base: '/anime/kissanime' },
      '123anime': { base: '/anime/123anime' },
      animedao:   { base: '/anime/animedao' },
    },
  });
});

// ============================================
// GET /validate-key
// ============================================
app.get('/validate-key', async (req, res) => {
  const apiKey = req.query.apiKey || req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ 
      valid: false,
      message: 'Missing API key' 
    });
  }

  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key', apiKey)
    .eq('active', true)
    .single();

  if (error || !data) {
    return res.status(401).json({ 
      valid: false,
      message: 'Invalid API key' 
    });
  }

  res.json({ 
    valid: true,
    message: 'API key is valid',
    label: data.label
  });
});

// 🔒 Protected routes
app.use('/anime/animeyubi', auth, animeyubiProvider);
app.use('/anime/kissanime', auth, kissanimeProvider);
app.use('/anime/123anime',  auth, anime123Provider);
app.use('/anime/animedao',  auth, animedaoProvider);

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    providers: ['animeyubi', 'kissanime', '123animes', 'animedao'],
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
  });
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

app.listen(PORT, () => {
  console.log(`🚀 Anime Scraper API running on http://localhost:${PORT}`);
  console.log(`🔒 All /anime/* routes are protected`);
  console.log(`📺 AnimeDAO provider → /anime/animedao`);
});

export default app;