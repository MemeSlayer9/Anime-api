const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://elsqusmvaeyrcjqbqqfz.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsc3F1c212YWV5cmNqcWJxcWZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mjk1MTczNTEsImV4cCI6MjA0NTA5MzM1MX0.H3HV2HHIarOjmfe5Bmg0h9GQ07DG3EHkr_jh0XsK6EQ'
);

module.exports = supabase;