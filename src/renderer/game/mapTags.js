// Multiplayer map tags. Map makers build levels in the normal Happy Wheels editor and add text
// boxes whose text starts with "#mp":
//
//   #mp spawn [n]          a start position (racers are spread over them, in order of n)
//   #mp checkpoint [n]     R respawns you at the last checkpoint you touched (in order of n)
//   #mp collisions on|off  this map decides whether racers collide
//
// In races the tags are read before the level is built and their text is blanked, so they never
// show. (Map makers can also give them 0% opacity to hide them in normal play.)

const TAG = /^\s*#mp\s+([a-z]+)(?:\s+(\S+))?/i;

function specialContainer(level) {
  const guide = level && level.shapeGuide;
  const kids = guide && guide.children;
  return kids ? kids.find((c) => c && c.name === 'special') || null : null;
}

/**
 * Reads the tags of a player-made level that hasn't been built yet and blanks the tag text boxes. Positions are in level pixels (the editor's units). Returns null for levels without tags.
 */
export function takeMapTags(level) {
  const special = specialContainer(level);
  if (!special || !special.children) return null;
  const tags = { spawns: [], checkpoints: [], collisions: null };
  let found = false;
  for (const item of [...special.children]) {
    if (!item || item._type !== 'TextBoxRef' || typeof item._caption !== 'string') continue;
    const m = TAG.exec(item._caption);
    if (!m) continue;
    found = true;
    const kind = m[1].toLowerCase();
    const arg = (m[2] || '').toLowerCase();
    const order = Number.parseFloat(arg);
    const point = { x: Number(item.x) || 0, y: Number(item.y) || 0, order: Number.isFinite(order) ? order : null };
    if (kind === 'spawn') tags.spawns.push(point);
    else if (kind === 'checkpoint') tags.checkpoints.push(point);
    else if (kind === 'collisions' && (arg === 'on' || arg === 'off')) tags.collisions = arg === 'on';
    // Blank the text rather than removing the box: triggers and groups may refer to it.
    item._caption = '';
  }
  if (!found) return null;
  // Numbered tags in their order, unnumbered ones after them in the order they were placed.
  const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity);
  tags.spawns.sort(byOrder);
  tags.checkpoints.sort(byOrder);
  return tags;
}
