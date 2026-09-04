const { getShowtimes } = require('./voxScraper');
const { getAllWatches, getWatchState, setWatchState } = require('./db');
const { sendBookingOpenEmail } = require('./emailer');

/**
 * Builds the group key that identifies a unique underlying check -
 * every watch (from any user) that resolves to the same key shares one
 * scrape and one persisted state, instead of each user triggering their
 * own separate scrape of the same page.
 */
function groupKeyFor(watch) {
  if (watch.type === 'date') {
    return `date|${watch.cinema}|${watch.movie}|${watch.date}`;
  }
  return `movie|${watch.cinema}|${watch.movie}`;
}

/**
 * MODE 1: check a specific date once for the whole group.
 */
async function checkDateGroup(groupKey, { cinema, movie, date }) {
  const previousState = getWatchState(groupKey);
  const isFirstEverCheck = previousState === null;
  const wasOpenBefore = previousState?.bookingOpen ?? false;

  const result = await getShowtimes(cinema, movie, date);
  setWatchState(groupKey, result);

  // On the very first check, there's nothing to compare against - just
  // record the baseline silently rather than notifying about dates that
  // may have already been open for a while before anyone started watching.
  if (isFirstEverCheck) {
    return { justOpened: false, newlyOpenedDates: [] };
  }

  return {
    justOpened: !wasOpenBefore && result.bookingOpen,
    newlyOpenedDates: !wasOpenBefore && result.bookingOpen ? [date] : [],
  };
}

/**
 * MODE 2: check a rolling window once for the whole group. If multiple
 * users watching the same movie asked for different daysAhead windows,
 * we use the largest requested window so nobody's request is under-covered.
 */
async function checkMovieGroup(groupKey, { cinema, movie, daysAhead }) {
  const previousState = getWatchState(groupKey);
  const isFirstEverCheck = previousState === null;
  const previousOpenDates = new Set(previousState?.openDates ?? []);

  const currentOpenDates = new Set();

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');

    try {
      const { bookingOpen } = await getShowtimes(cinema, movie, dateStr, { freshSession: true });
      if (bookingOpen) currentOpenDates.add(dateStr);
    } catch (err) {
      console.warn(`  (skipped ${dateStr} for ${movie}: ${err.message})`);
    }

    if (i < daysAhead - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1500));
    }
  }

  setWatchState(groupKey, { openDates: [...currentOpenDates] });

  // On the very first check, just record what's currently open as the
  // baseline - don't treat it as "newly opened" since it may have been
  // open for a while before anyone started watching.
  if (isFirstEverCheck) {
    return { justOpened: false, newlyOpenedDates: [] };
  }

  const newlyOpenedDates = [...currentOpenDates].filter((d) => !previousOpenDates.has(d));
  return { justOpened: newlyOpenedDates.length > 0, newlyOpenedDates };
}

/**
 * Loads every individual watch (one row per user per request), groups
 * them by unique (cinema, movie, type[, date]) combo, scrapes each group
 * exactly ONCE regardless of how many users are watching it, then emails
 * every user in that group if it just opened.
 */
async function pollAllWatches() {
  const watches = getAllWatches();

  const groups = new Map(); // groupKey -> { representative watch info, watchers: [emails] }
  for (const watch of watches) {
    const key = groupKeyFor(watch);
    if (!groups.has(key)) {
      groups.set(key, { cinema: watch.cinema, movie: watch.movie, type: watch.type, date: watch.date, daysAhead: watch.days_ahead || 7, watchers: new Set() });
    }
    groups.get(key).watchers.add(watch.email);
  }

  console.log(`Checking ${groups.size} unique cinema+movie combo(s) across ${watches.length} total watch(es)...`);

  for (const [groupKey, group] of groups) {
    try {
      const result =
        group.type === 'movie'
          ? await checkMovieGroup(groupKey, group)
          : await checkDateGroup(groupKey, group);

      if (result.justOpened) {
        console.log(
          `New booking date(s) opened for ${group.movie} at ${group.cinema}: ${result.newlyOpenedDates.join(', ')} - notifying ${group.watchers.size} user(s)`
        );
        for (const email of group.watchers) {
          await sendBookingOpenEmail(email, group, result);
        }
      } else {
        console.log(`No change for ${group.movie} at ${group.cinema} (${group.watchers.size} watcher(s)).`);
      }
    } catch (err) {
      console.error(`Failed checking ${group.movie} at ${group.cinema}:`, err.message);
    }
  }
}

module.exports = { pollAllWatches };
