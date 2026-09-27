// Host tools: remove (kick) players, lock the lobby, and hand the host role to someone else.
//
// Steam lobbies can't kick or change their owner, so:
// - A kicked player's own mod leaves the lobby when told to. The host keeps a ban list, re-kicks a
//   banned player who comes back, and everyone ignores their packets.
// - "Host" is a lobby data value only the Steam lobby owner can write. The owner writes whoever the
//   current host names (normally the owner itself); without it the owner is the host.

import { V } from './protocol.js';

export const hostToolMethods = {
  /** The Steam lobby owner (the only one who can write lobby data). */
  get isSteamOwner() { return !!(this.lobby && this.self && this.lobby.owner === this.self.id); },

  isBanned(id) { return this.settings.banned.includes(id); },

  /** Host: a banned player is talking to us again (they rejoined); tell them to go, at most every 2 s. */
  rekick(id) {
    const now = performance.now();
    const seen = (this.rekicked ||= new Map());
    if (now - (seen.get(id) ?? -Infinity) < 2000) return;
    seen.set(id, now);
    this.sendTo(id, { t: 'kick', target: id });
  },

  /** Host: remove a player from the lobby (they can't come back while this host runs it). */
  kick(id) {
    const p = this.players.get(id);
    if (!this.isHost || !p || p.bot || id === this.self.id) return;
    if (!this.settings.banned.includes(id)) this.settings.banned.push(id);
    this.sendAll({ t: 'kick', target: id });
    this.dropPlayer(id);
    this.toast(`${p.name} was removed from the lobby`);
    this.lobbyChanged();
  },

  /** Host: lock the lobby so nobody new can join (players already here can rejoin). */
  setLocked(on) {
    if (!this.isHost) return;
    this.settings.locked = !!on;
    if (this.isSteamOwner) this.tx.lobby.setJoinable(!on).catch(() => {});
    this.lobbyChanged();
  },

  /** Host: hand the host role to another player. */
  makeHost(id) {
    const p = this.players.get(id);
    if (!this.isHost || !p || p.bot || id === this.self.id || !this.lobby.members.includes(id)) return;
    if (this.isSteamOwner) this.tx.lobby.setData({ host: id }).catch(() => {});
    else this.sendTo(this.lobby.owner, { t: 'hostTo', target: id });
    this.sendAll({ t: 'notice', text: `${p.name} is the host now` });
    this.toast(`${p.name} is the host now`);
  },

  /** Host tools messages; returns true if handled. */
  hostToolCtrl(from, m) {
    switch (m.t) {
      case 'kick': {
        if (from !== this.hostId || !V.id(m.target)) return true;
        if (m.target === this.self.id) {
          this.leave().catch(() => {});
          this.toast(m.reason === 'locked' ? 'That lobby is locked' : 'The host removed you from the lobby', 'error');
          this.notify({ openPanel: true });
        } else {
          if (!this.settings.banned.includes(m.target)) this.settings.banned.push(m.target);
          this.dropPlayer(m.target);
          this.changed();
        }
        return true;
      }
      case 'hostTo': {
        // Only the Steam owner can change lobby data, and only on the current host's word.
        if (!this.isSteamOwner || from !== this.hostId || !V.id(m.target) || !this.lobby.members.includes(m.target)) return true;
        this.tx.lobby.setData({ host: m.target }).catch(() => {});
        return true;
      }
      default:
        return false;
    }
  },
};
