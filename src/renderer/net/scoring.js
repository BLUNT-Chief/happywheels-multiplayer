// Rankings and points, shared by the race HUD, the results, cups, the session leaderboard and
// career stats, so they always agree.

/** Points for 1st, 2nd, ... place (cups and the session leaderboard). */
export const PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
export const pointsFor = (place) => (place ? PLACE_POINTS[place - 1] || 0 : 0);

/**
 * Orders a race's racers.
 *   Race:     finishers by time, then everyone else by how far they got (laps/checkpoints), then
 *             racers who left.
 *   Survival: finishers, then survivors, then the fallen (whoever lasted longest first), then
 *             racers who left.
 * Returns rows { id, place, ms, dnf, dead, deadMs, progress } best first. `place` is null for
 * racers who get no placing (left, or never got anywhere in a race nobody could finish).
 */
export function rankRace(race) {
  const survival = !!(race.rules && race.rules.mode === 'survival');
  const rows = race.participants.map((id) => {
    const ms = race.finishes[id];
    const deadMs = race.deaths ? race.deaths[id] : undefined;
    return {
      id,
      ms: ms == null ? null : ms,
      dnf: race.dnf.has(id),
      dead: deadMs != null,
      deadMs: deadMs == null ? null : deadMs,
      progress: (race.progress && race.progress[id]) || 0,
    };
  });
  const key = (r) => {
    if (r.ms != null) return [0, r.ms];
    if (survival) {
      if (r.dead) return [2, -r.deadMs];
      if (r.dnf) return [3, 0];
      return [1, -r.progress];
    }
    if (r.dnf) return [3, -r.progress];
    return [1, -r.progress];
  };
  rows.sort((a, b) => { const ka = key(a); const kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1]; });
  let place = 0;
  for (const r of rows) {
    const placed = r.ms != null || (survival ? r.dead || !r.dnf : !r.dnf && r.progress > 0);
    r.place = placed ? ++place : null;
  }
  return rows;
}

/** The winner's id, or null. */
export function winnerOf(race) {
  const top = rankRace(race)[0];
  return top && top.place === 1 ? top.id : null;
}

/** Adds a finished race to a points table { id: { points, wins, podiums, races } }. */
export function addRaceToTable(table, race, nameOf) {
  const rows = rankRace(race);
  const racers = rows.length;
  for (const r of rows) {
    const t = table[r.id] || (table[r.id] = { name: '', points: 0, wins: 0, podiums: 0, races: 0 });
    t.name = nameOf(r.id) || t.name || 'Player';
    t.races++;
    t.points += pointsFor(r.place);
    if (r.place === 1 && racers > 1) t.wins++;
    if (r.place && r.place <= 3 && racers > 2) t.podiums++;
  }
  return table;
}

/** Table rows, best first; `place` is shared by rows with the same points and wins (1, 1, 3…). */
export function tableRows(table) {
  const rows = Object.entries(table || {}).map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.place = prev && prev.points === r.points && prev.wins === r.wins ? prev.place : i + 1;
  });
  return rows;
}
