// Level votes: after a race, the host offers three random levels, everyone taps one, and the most
// popular one is raced next (ties are broken at random). The vote lives in the host's lobby
// settings; votes are sent to the host.

import { V, cleanText } from './protocol.js';

const VOTE_MS = 20000;
const OPTIONS = 3;

const cleanLevel = (l) => (l && V.int(l.id, 1, 2e9)
  ? { id: l.id, name: cleanText(l.name || `Level ${l.id}`, 80), author: cleanText(l.author || '', 40), character: V.int(l.character, 0, 11) ? l.character : 0, forceChar: !!l.forceChar }
  : null);

export function sanitizeVote(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.options)) return null;
  const options = v.options.map(cleanLevel).filter(Boolean).slice(0, OPTIONS);
  if (!options.length || !V.int(v.id, 1, 1e9) || !V.num(v.endsAt)) return null;
  const votes = {};
  if (v.votes && typeof v.votes === 'object') {
    for (const [id, i] of Object.entries(v.votes).slice(0, 32)) if (V.id(id) && V.int(i, 0, options.length - 1)) votes[id] = i;
  }
  return { id: v.id, options, votes, endsAt: v.endsAt };
}

/** Vote counts per option. */
export const voteCounts = (vote) => vote.options.map((_, i) => Object.values(vote.votes).filter((x) => x === i).length);

/** Host (and voter) methods, mixed into Multiplayer. */
export const voteMethods = {
  /** Host: offer three random levels nobody in this lobby has raced yet. */
  async voteStart() {
    if (!this.isHost || this.racing() || this.settings.vote || this.settings.cup.active) return;
    const all = await this.bridge.featuredLevels();
    const current = this.settings.level && this.settings.level.id;
    let pool = all.filter((l) => !this.playedLevels.has(l.id) && l.id !== current);
    if (pool.length < OPTIONS) pool = all.filter((l) => l.id !== current);
    const options = [];
    while (options.length < OPTIONS && pool.length) options.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    if (!options.length) return;
    this.settings.vote = { id: (this.voteCounter = (this.voteCounter || 0) + 1), options: options.map(cleanLevel), votes: {}, endsAt: this.clock.now() + VOTE_MS };
    clearTimeout(this.voteTimer);
    this.voteTimer = setTimeout(() => this.voteFinish(), VOTE_MS + 100);
    this.lobbyChanged();
  },

  /** Anyone: vote for option i of the current vote. */
  voteCast(i) {
    const v = this.settings.vote;
    if (!v || !V.int(i, 0, v.options.length - 1)) return;
    this.myVote = { id: v.id, i };
    this.sendHost({ t: 'voteLevel', vote: v.id, i });
    this.changed();
  },

  /** Host: a vote arrived. */
  voteReceived(from, m) {
    const v = this.settings.vote;
    const p = this.players.get(from);
    if (!this.isHost || !v || m.vote !== v.id || !p || p.bot || !V.int(m.i, 0, v.options.length - 1)) return;
    v.votes[from] = m.i;
    const voters = [...this.players.values()].filter((x) => !x.bot);
    if (voters.every((x) => v.votes[x.id] != null)) this.voteFinish();
    else this.lobbyChanged();
  },

  /** Host: count the votes and race the winner. */
  voteFinish() {
    const v = this.settings.vote;
    clearTimeout(this.voteTimer);
    if (!this.isHost || !v) return;
    const counts = voteCounts(v);
    const top = Math.max(...counts);
    const best = v.options.filter((_, i) => counts[i] === top);
    const pick = best[Math.floor(Math.random() * best.length)];
    this.settings.vote = null;
    this.sendAll({ t: 'notice', text: `Next up: ${pick.name}` });
    this.toast(`Next up: ${pick.name}`);
    this.setLevel(pick);
    this.startRace();
  },

  voteCancel() {
    if (!this.isHost || !this.settings.vote) return;
    clearTimeout(this.voteTimer);
    this.settings.vote = null;
    this.lobbyChanged();
  },
};
