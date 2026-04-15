require('dotenv').config();

const express = require('express');
const cors = require('cors');

const animeyubiProvider = require('./providers/animeyubi');
const auth = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    message: 'Anime Scraper API',
    version: '1.0.0',
    providers: {
      animeyubi: { base: '/anime/animeyubi' },
    }
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

  const supabase = require('./supabaseClient');

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

// 🔒 Protected
app.use('/anime/animeyubi', auth, animeyubiProvider);

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    providers: ['animeyubi']
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

app.listen(PORT, () => {
  console.log(`🚀 Anime Scraper API running on http://localhost:${PORT}`);
  console.log(`🔒 /anime/animeyubi is protected`);
});

module.exports = app;