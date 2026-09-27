// Cups: the host lines up several levels, racers score points for their placing in each race
// (see scoring.js), and the best total after the last race wins the cup. Cup state lives in the
// host's lobby settings, so everyone sees the same line-up and standings.

import { addRaceToTable, tableRows } from './scoring.js';
import { V, cleanText } from './protocol.js';

export const MAX_CUP_LEVELS = 8;

export const newCup = () => ({ levels: [], active: false, index: 0, table: {}, done: false, scored: -1 });

const cleanLevel = (l) => (l && V.int(l.id, 1, 2e9)
  ? { id: l.id, name: cleanText(l.name || `Level ${l.id}`, 80), author: cleanText(l.author || '', 40), character: V.int(l.character, 0, 11) ? l.character : 0, forceChar: !!l.forceChar }
  : null);

/** A cup from the host's snapshot, checked field by field. */
export function sanitizeCup(c) {
  if (!c || typeof c !== 'object') return newCup();
  const levels = Array.isArray(c.levels) ? c.levels.map(cleanLevel).filter(Boolean).slice(0, MAX_CUP_LEVELS) : [];
  const table = {};
  if (c.table && typeof c.table === 'object') {
    for (const [id, t] of Object.entries(c.table).slice(0, 32)) {
      if (!V.id(id) || !t || typeof t !== 'object') continue;
      table[id] = {
        name: cleanText(t.name, 32) || 'Player',
        points: V.int(t.points, 0, 1e5) ? t.points : 0, wins: V.int(t.wins, 0, 1e4) ? t.wins : 0,
        podiums: V.int(t.podiums, 0, 1e4) ? t.podiums : 0, races: V.int(t.races, 0, 1e4) ? t.races : 0,
      };
    }
  }
  return {
    levels, table, active: !!c.active, done: !!c.done,
    index: V.int(c.index, 0, MAX_CUP_LEVELS) ? c.index : 0,
    scored: V.int(c.scored, -1, MAX_CUP_LEVELS) ? c.scored : -1,
  };
}

export const cupRows = (cup) => tableRows(cup && cup.table);

/** The cup's winner(s): { ids, names, tie } (null before anyone scored). */
export function cupWinner(cup) {
  const rows = cupRows(cup);
  if (!rows.length) return null;
  const top = rows.filter((r) => r.points === rows[0].points && r.wins === rows[0].wins);
  return { ids: top.map((r) => r.id), names: top.map((r) => r.name), tie: top.length > 1 };
}

export function cupWinnerText(cup) {
  const w = cupWinner(cup);
  if (!w) return 'The cup is over';
  if (w.tie) return `It's a tie: ${w.names.slice(0, -1).join(', ')} and ${w.names[w.names.length - 1]}!`;
  return `${w.names[0]} wins the cup!`;
}

/** Host methods, mixed into Multiplayer. */
export const cupMethods = {
  cupEditable() { return this.isHost && !this.settings.cup.active && !this.racing(); },

  cupAdd(level) {
    const cup = this.settings.cup;
    const l = cleanLevel(level);
    if (!this.cupEditable() || !l || cup.levels.length >= MAX_CUP_LEVELS) return false;
    if (cup.done) Object.assign(cup, newCup());
    cup.levels.push(l);
    this.lobbyChanged();
    return true;
  },

  cupRemove(i) {
    if (!this.cupEditable()) return;
    this.settings.cup.levels.splice(i, 1);
    this.lobbyChanged();
  },

  cupClear() {
    if (!this.isHost || this.racing()) return;
    this.settings.cup = newCup();
    this.lobbyChanged();
  },

  cupStart() {
    const cup = this.settings.cup;
    if (!this.isHost || this.racing() || cup.active || cup.levels.length < 2) return;
    Object.assign(cup, { active: true, index: 0, table: {}, done: false, scored: -1 });
    this.sendAll({ t: 'notice', text: `Cup started: ${cup.levels.length} races` });
    this.toast(`Cup started: ${cup.levels.length} races`);
    this.setLevel(cup.levels[0]);
    this.startRace();
  },

  /** Host, after a cup race's results: on to the next level. */
  cupNext() {
    const cup = this.settings.cup;
    if (!this.isHost || !cup.active || this.racing() || cup.index + 1 >= cup.levels.length) return;
    cup.index++;
    this.setLevel(cup.levels[cup.index]);
    this.startRace();
  },

  cupEnd() {
    const cup = this.settings.cup;
    if (!this.isHost || !cup.active) return;
    cup.active = false;
    cup.done = Object.keys(cup.table).length > 0;
    this.lobbyChanged();
  },

  /** Host, when a race's results come in: score it if it was a cup race. */
  cupScore(race) {
    const cup = this.settings.cup;
    if (!this.isHost || !cup.active || race.cupIndex !== cup.index || cup.scored === cup.index) return;
    addRaceToTable(cup.table, race, (id) => this.players.get(id)?.name);
    cup.scored = cup.index;
    if (cup.index + 1 >= cup.levels.length) {
      cup.active = false;
      cup.done = true;
      const text = cupWinnerText(cup);
      this.sendAll({ t: 'notice', text });
      this.toast(text);
    }
    this.lobbyChanged();
  },
};
