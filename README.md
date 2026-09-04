# Cinema Booking Notifier

## The Problem

Egyptian cinemas (starting with VOX Cinemas) don't notify customers when
ticket booking opens for a movie. Popular showtimes — especially opening
weekends and specific formats like IMAX/4DX — can sell out within hours
of booking opening, but there's no way to know the exact moment it
happens. This project solves that: pick a movie and cinema, and get an
email the moment tickets become bookable.

## How It Works (User's Perspective)

1. Visit the website, pick a cinema and a movie from dropdowns (populated
   live from VOX's actual "Now Showing" and "Coming Soon" listings)
2. Choose how you want to be notified:
   - **A specific date** — e.g. "tell me when Saturday Nov 8th opens"
   - **The movie generally** — e.g. "tell me the moment ANY new date
     becomes bookable" (better for movies that haven't opened their
     calendar at all yet)
3. Enter your email and submit
4. In the background, the system checks VOX's site automatically every
   10 minutes. The moment your movie/date becomes bookable, you get an
   email — before most people even think to check manually.

## Architecture

```
┌─────────────┐      ┌─────────────┐      ┌──────────────┐
│   Browser    │─────▶│   Express    │─────▶│    SQLite     │
│ (index.html) │◀─────│  (server.js) │◀─────│    (vox.db)   │
└─────────────┘      └──────┬───────┘      └──────────────┘
                             │
                             │ every 10 min (node-cron)
                             ▼
                     ┌───────────────┐      ┌──────────────┐
                     │ checkBooking  │─────▶│  Puppeteer    │
                     │  Opened.js    │      │ (voxScraper)  │
                     └───────┬───────┘      └───────┬──────┘
                             │                       │
                             ▼                       ▼
                     ┌───────────────┐      ┌──────────────┐
                     │  emailer.js   │      │  VOX Cinemas  │
                     │   (Gmail)     │      │   website     │
                     └───────────────┘      └──────────────┘
```

### The pieces

| File | Job |
|---|---|
| `public/index.html` | The form — dropdowns for cinema/movie, populated live via `/options` |
| `server.js` | Express web server; handles form submissions; runs the scheduler |
| `voxScraper.js` | Talks to VOX's actual website (Puppeteer + Cheerio) |
| `db.js` | SQLite database — stores watches and last-known state |
| `checkBookingOpened.js` | The core logic: groups watches, detects new openings |
| `emailer.js` | Sends real emails via Gmail (App Password) |

## Key Technical Challenges (and how they were solved)

**1. VOX's site blocks plain HTTP requests.**
A simple `axios` GET request just hung and timed out — VOX uses Akamai
bot protection that silently tarpits requests that don't look like a
real browser. Solved by switching to **Puppeteer**, driving a real
headless Chromium instance instead.

**2. Reusing one browser session got throttled.**
Making several requests back-to-back from the same browser session
(even fresh pages) started failing after the first request. Solved by
giving each request its own **isolated browser context** (fresh cookies/
session), mimicking a brand-new visitor each time.

**3. No API — showtimes are server-rendered HTML.**
Rather than reverse-engineering a private API, showtimes are parsed
directly out of the rendered page HTML using **Cheerio**, matching on
VOX's structure (`<article class="movie-compare" data-slug="...">`,
nested by screen type and session).

**4. A subtle false-positive bug.**
Requesting a not-yet-open movie+date combo sometimes made VOX's site
silently render a *different, unrelated* movie's showtimes instead of
an empty page. Fixed by verifying the `data-slug` on the page actually
matches the movie being checked, before trusting any sessions found.

**5. Avoiding duplicate work at scale.**
Originally, every user's watch was checked independently — meaning 20
friends watching the same movie meant 20 redundant scrapes of the same
page. Fixed by grouping all watches by their unique
(cinema, movie, date) combination, scraping each combo exactly once,
then fanning the notification out to everyone watching it.

**6. First-check false alarms.**
On a brand new watch, there's no prior history to compare against — so
without a fix, anything already open would be (wrongly) reported as
"just opened." Fixed by treating the first-ever check as a silent
baseline: only genuinely *new* openings after that trigger a
notification.

## Tech Stack

- **Backend:** Node.js, Express
- **Scraping:** Puppeteer (headless Chromium) + Cheerio (HTML parsing)
- **Database:** SQLite (`better-sqlite3`)
- **Scheduling:** node-cron (checks every 10 minutes)
- **Email:** Nodemailer via Gmail (App Password)
- **Frontend:** Plain HTML/CSS/JS (dropdowns populated via fetch)

## Known Limitations / Future Work

- Currently supports VOX Cinemas only — architecture is designed so
  other Egyptian chains can be added as their own scraper module later
- Runs locally for now — not yet deployed to a live server (candidates:
  Oracle Cloud's Always Free tier, for genuinely free permanent hosting)
- A transient scrape failure for one date could theoretically cause a
  rare duplicate notification for that date later (low-impact edge case,
  not yet hardened against)
