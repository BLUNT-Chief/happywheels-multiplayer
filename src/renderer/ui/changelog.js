// "What's new" notes, shown once after an update. Newest version first.

export const CHANGELOG = [
  {
    version: '0.2.0',
    title: 'Game modes, map tools and more',
    items: [
      ['Cups', 'Line up several levels, score points for every placing, and crown a cup winner.'],
      ['Survival', 'Last racer alive wins. Pick it in the lobby, or maps can set it.'],
      ['Level vote', 'After a race, everyone votes for the next level out of three.'],
      ['Practice', 'Race a ghost of your personal best on any level, from the level browser.'],
      ['Your best as AI', 'Add an AI racer that drives your own best run, great for brand-new maps.'],
      ['Map maker tools', 'Maps can now set laps, their own finish line, time limits, characters, AI rules and more. Test mode shows your markers and warns about mistakes.'],
      ['Host tools', 'Remove players, lock the lobby, or hand the host role to someone else.'],
      ['Auto-start', 'Start the race as soon as everyone is ready.'],
      ['Spectate', 'After you finish, press Tab to watch the other racers.'],
      ['Quick chat', 'Keys 1 to 6 during a race: GG, Nice, Oops and more.'],
      ['Stats and leaderboard', 'Personal bests, career stats, and standings for your lobby session.'],
      ['Settings', 'Ghost visibility, name tags, HUD size, quick chat keys and checkpoint markers.'],
    ],
  },
];

/** Notes for versions newer than `seen` (all of them if nothing was seen yet), up to `current`. */
export function notesSince(seen, current) {
  const newer = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
    return false;
  };
  return CHANGELOG.filter((c) => (!seen || newer(c.version, seen)) && !newer(c.version, current));
}
