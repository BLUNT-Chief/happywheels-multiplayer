// Prints the changelog text for a Nexus Mods file version (used by the release workflow): the
// in-game "What's new" entry for that version if there is one, and a link to the full notes.
// usage: node scripts/nexus-changelog.mjs 0.2.2
import { CHANGELOG } from '../src/renderer/ui/changelog.js';

const version = String(process.argv[2] || '').replace(/^v/, '');
const entry = CHANGELOG.find((c) => c.version === version);
const lines = entry ? entry.items.map(([title, text]) => `${title}: ${text}`) : ['Fixes and improvements.'];
lines.push(
  '',
  'Everyone in a lobby needs the same version to race together.',
  `Full release notes: https://github.com/BLUNT-Chief/happywheels-multiplayer/releases/tag/v${version}`,
);
console.log(lines.join('\n'));
