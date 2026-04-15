const supabase = require('../supabaseClient');

const auth = async (req, res, next) => {
  // accepts ?apiKey=xxx in URL or x-api-key header
  const apiKey = req.query.apiKey || req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing API key' });
  }

  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key', apiKey)
    .eq('active', true)
    .single();

  if (error || !data) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
  }

  next();
};

module.exports = auth;