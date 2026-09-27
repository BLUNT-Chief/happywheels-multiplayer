// Career stats for the local player, kept on this PC.

const KEY = 'hwmp.stats';
const EMPTY = { races: 0, finishes: 0, wins: 0, podiums: 0, dnfs: 0, bestPlace: null, survivalWins: 0, aiBeaten: 0, cupsWon: 0, since: 0 };

export function readStats() {
  try { return { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch { return { ...EMPTY }; }
}

function write(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

/**
 * Adds one race: { place, racers, finished, left, survival, aiBehind } (aiBehind: AI racers that
 * placed behind us).
 */
export function recordRace({ place, racers, finished, left, survival, aiBehind = 0 }) {
  const s = readStats();
  if (!s.since) s.since = Date.now();
  s.races++;
  if (finished) s.finishes++;
  if (left) s.dnfs++;
  if (place === 1 && racers > 1) { s.wins++; if (survival) s.survivalWins++; }
  if (place && place <= 3 && racers > 2) s.podiums++;
  if (place && racers > 1 && (s.bestPlace == null || place < s.bestPlace)) s.bestPlace = place;
  s.aiBeaten += aiBehind;
  write(s);
  return s;
}

export function recordCupWin() {
  const s = readStats();
  s.cupsWon++;
  write(s);
}

export function resetStats() { write({ ...EMPTY, since: Date.now() }); }
