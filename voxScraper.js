const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

// Reuse a single browser instance across many checks instead of launching
// a fresh one every time (much faster + lighter for repeated polling).
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Force HTTP/1.1 instead of HTTP/2 - repeated navigations to the
        // same origin within one browser instance were failing with
        // ERR_HTTP2_PROTOCOL_ERROR after the first successful request,
        // consistent with Chromium's HTTP/2 connection coalescing
        // breaking against this site on reuse.
        '--disable-http2',
      ],
    });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Shared helper: loads a URL through headless Chromium and returns the
 * rendered HTML. Used by getShowtimes() and by the cinema/movie list
 * scrapers below, so they all share the same bot-detection workarounds
 * (fresh isolated sessions, HTTP/1.1, proper user agent).
 */
async function fetchRenderedHtml(url, options = {}) {
  const { sharedPage = null, freshSession = false } = options;
  const browser = await getBrowser();

  let context = null;
  let page = sharedPage;

  if (!page) {
    if (freshSession) {
      context = await browser.createBrowserContext();
      page = await context.newPage();
    } else {
      page = await browser.newPage();
    }
  }

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return await page.content();
  } finally {
    if (context) {
      await context.close();
    } else if (!sharedPage) {
      await page.close();
    }
  }
}

/**
 * Fetches showtimes for a given cinema + movie + date from VOX Egypt,
 * and returns a structured list of sessions (or an empty list if
 * booking hasn't opened yet for that movie/cinema/date).
 *
 * Uses a real headless Chromium browser (Puppeteer) instead of a plain
 * HTTP request, because VOX's Akamai bot protection silently blocks
 * non-browser requests (they just hang/timeout rather than returning
 * an explicit error).
 *
 * @param {string} cinemaSlug e.g. "mall-of-egypt"
 * @param {string} movieSlug  e.g. "spider-man-brand-new-day"
 * @param {string} dateYYYYMMDD e.g. "20260902"
 */
async function getShowtimes(cinemaSlug, movieSlug, dateYYYYMMDD, options = {}) {
  const url = `https://egy.voxcinemas.com/showtimes?c=${cinemaSlug}&m=${movieSlug}&d=${dateYYYYMMDD}`;
  const html = await fetchRenderedHtml(url, options);
  const $ = cheerio.load(html);

  // NOTE: VOX shows different messages depending on the situation
  // ("Private booking not open for public", "No showtimes could be
  // found for your current cinema(s), movie(s) and date.", possibly
  // others). Rather than matching fragile text, we just check whether
  // any actual <li data-id="..."> session elements exist in the HTML.
  // If none are found, booking isn't open yet for that date - whatever
  // the reason or wording.

  const sessions = [];

  // Each movie block is <article class="movie-compare" data-slug="...">.
  // IMPORTANT: VOX sometimes falls back to rendering a DIFFERENT movie's
  // showtimes when the requested movie+date combo has nothing real (seen
  // in testing - requesting a "coming soon" movie's showtimes page
  // rendered an unrelated already-showing movie's sessions instead of an
  // empty result). So we only trust an article block whose data-slug (or
  // data-identifier) actually matches the movie we asked for - anything
  // else gets ignored, even if it contains real-looking sessions.
  $('article.movie-compare').each((_, movieEl) => {
    const articleSlug =
      $(movieEl).attr('data-slug') || $(movieEl).attr('data-identifier');

    if (articleSlug !== movieSlug) {
      return; // not the movie we asked about - skip, don't count its sessions
    }

    const movieTitle = $(movieEl).find('.movie-hero h2').text().trim();

    // Showtimes are grouped by screen type (MAX, GOLD, 4DX, Standard...)
    $(movieEl)
      .find('.dates > ol.showtimes > li')
      .each((_, screenGroupEl) => {
        const screenType = $(screenGroupEl).find('> strong').first().text().trim();

        $(screenGroupEl)
          .find('> ol > li[data-id]')
          .each((_, sessionEl) => {
            const sessionId = $(sessionEl).attr('data-id');
            const timeText = $(sessionEl).find('a.showtime').text().trim();
            const bookingUrl = $(sessionEl).find('a.showtime').attr('href');
            const is3D = $(sessionEl).find('a.showtime span').text().trim();

            sessions.push({
              sessionId,
              movieTitle,
              screenType,
              time: timeText.replace(is3D, '').trim(),
              format: is3D || '2D',
              bookingUrl,
            });
          });
      });
  });

  return { bookingOpen: sessions.length > 0, sessions };
}

/**
 * Fetches the list of VOX cinemas (slug + display name), scraped from
 * the cinema checkboxes on the showtimes quick-filter form. Any page
 * with that form works - we just use the whatson page since it always
 * exists regardless of which movies are currently showing.
 */
async function getCinemas() {
  const html = await fetchRenderedHtml('https://egy.voxcinemas.com/movies/whatson', {
    freshSession: true,
  });
  const $ = cheerio.load(html);

  const cinemas = [];
  $('.pseudo-multi-select.cinemas .values li label').each((_, labelEl) => {
    const slug = $(labelEl).find('input').attr('value');
    const name = $(labelEl).find('span').text().trim();
    if (slug && name) cinemas.push({ slug, name });
  });

  return cinemas;
}

/**
 * Fetches a movie list (either "What's On" or "Coming Soon") by parsing
 * the JSON-LD structured data VOX embeds in the page
 * (<script type="application/ld+json">), which lists each movie's name
 * and URL. This is far more reliable than scraping the visual movie
 * cards directly, since structured data is meant to be machine-readable.
 *
 * @param {'whatson' | 'comingsoon'} pageType
 */
async function getMovieList(pageType) {
  const url = `https://egy.voxcinemas.com/movies/${pageType}`;
  const html = await fetchRenderedHtml(url, { freshSession: true });
  const $ = cheerio.load(html);

  const movies = [];
  $('script[type="application/ld+json"]').each((_, scriptEl) => {
    let data;
    try {
      data = JSON.parse($(scriptEl).html());
    } catch {
      return; // not valid JSON, skip
    }

    if (data['@type'] === 'itemList' && Array.isArray(data.itemListElement)) {
      data.itemListElement.forEach((entry) => {
        const item = entry.item;
        if (item && item.name && item.url) {
          const slug = item.url.split('/').filter(Boolean).pop();
          movies.push({ slug, title: item.name });
        }
      });
    }
  });

  return movies;
}

/**
 * Convenience: fetches both lists together, in the order the dropdown
 * should display them (now-showing first, coming-soon after).
 */
async function getMovieOptions() {
  const [nowShowing, comingSoon] = await Promise.all([
    getMovieList('whatson'),
    getMovieList('comingsoon'),
  ]);
  return { nowShowing, comingSoon };
}

module.exports = { getShowtimes, closeBrowser, getBrowser, getCinemas, getMovieList, getMovieOptions };
