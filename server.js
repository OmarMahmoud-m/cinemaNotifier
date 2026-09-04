const express = require('express');
const cron = require('node-cron');
const path = require('path');

const { addWatch } = require('./db');
const { pollAllWatches } = require('./checkBookingOpened');
const { getCinemas, getMovieOptions } = require('./voxScraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache of cinema/movie dropdown options. Refreshed periodically in the
// background (see the cron job below) rather than scraped on every page
// load, since scraping takes several seconds and shouldn't block the
// visitor's page load.
let optionsCache = { cinemas: [], nowShowing: [], comingSoon: [] };

async function refreshOptionsCache() {
  try {
    console.log('Refreshing cinema/movie options...');
    const [cinemas, movieOptions] = await Promise.all([getCinemas(), getMovieOptions()]);
    optionsCache = { cinemas, ...movieOptions };
    console.log(
      `Options refreshed: ${cinemas.length} cinemas, ${movieOptions.nowShowing.length} now showing, ${movieOptions.comingSoon.length} coming soon`
    );
  } catch (err) {
    console.error('Failed to refresh options:', err.message);
  }
}

app.get('/options', (req, res) => {
  res.json(optionsCache);
});

// Converts an HTML <input type="date"> value ("2026-09-10") into the
// YYYYMMDD format VOX's URLs use ("20260910").
function toVoxDateFormat(isoDate) {
  return isoDate.replace(/-/g, '');
}

app.post('/notify-me', (req, res) => {
  const { email, cinema, movie, type, date } = req.body;

  if (!email || !cinema || !movie || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (type === 'date' && !date) {
    return res.status(400).json({ error: 'Date is required for a date watch' });
  }

  try {
    const watchId = addWatch({
      email,
      type,
      cinema: cinema.trim(),
      movie: movie.trim(),
      date: type === 'date' ? toVoxDateFormat(date) : null,
      daysAhead: type === 'movie' ? 7 : null,
    });

    console.log(`New watch #${watchId} created: ${email} watching ${movie} at ${cinema} (${type})`);
    res.json({ success: true, watchId });
  } catch (err) {
    console.error('Failed to create watch:', err.message);
    res.status(500).json({ error: 'Failed to save your request' });
  }
});

app.listen(PORT, () => {
  console.log(`Cinema notifier running at http://localhost:${PORT}`);
});

// --- Background scheduler ---
// Runs every 10 minutes. Since watch state is persisted in SQLite (not
// in-memory), this is safe even if the server restarts between runs.
cron.schedule('*/10 * * * *', () => {
  console.log(`\n[${new Date().toISOString()}] Running scheduled check...`);
  pollAllWatches().catch((err) => console.error('Poll cycle failed:', err));
});

// Cinema/movie dropdown options change far less often than showtimes do,
// so refresh those every 3 hours instead of every 10 minutes.
cron.schedule('0 */3 * * *', refreshOptionsCache);

// Run both once immediately on startup, so you don't have to wait for
// the first scheduled cycle to see it working.
console.log('Running an initial check on startup...');
pollAllWatches().catch((err) => console.error('Initial poll failed:', err));
refreshOptionsCache();
