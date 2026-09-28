# Happy Wheels Multiplayer

Race your friends in Happy Wheels. Everyone joins a lobby, the host picks a level, and you all start from the same line on a synced countdown. Other racers show up in your game as real Happy Wheels characters, so every crash, lost limb and flying head is mirrored live.

- **Lobbies over Steam.** Create a lobby, invite friends or share a lobby code. There's no server to run: traffic goes peer-to-peer through Steam's relay network.
- **Any level.** A level browser with the 140+ featured levels and every player-made level on totaljerkface.com: search by name or author, sort by rating, plays or date, and see details before you pick. Or type a level ID.
- **Collisions on or off.** Off (the default): other racers are see-through ghosts you pass through. On: you can bump each other. Racers start out passable and turn solid once you've separated, so a shared start line doesn't send everyone flying.
- **Every character** works: wheelchair guy, segway guy, irresponsible dad (with kid), moped couple, Santa and his elves, and the rest.
- **AI racers** that drive real runs players uploaded, from Easy to Expert, or your own best run.
- **Game modes.** Races, survival (last one alive wins), cups over several levels, level votes, and session standings.
- **Map maker support.** Build multiplayer maps in the normal level editor: start positions, checkpoints, laps, your own finish line, time limits and more. See the [map making guide](docs/MAP_MAKING.md).
- **On your own too.** Practice any level against a ghost of your personal best, and keep career stats.
- **Automatic updates.** The mod updates itself in the background.

> Unofficial fan-made mod. Not affiliated with or endorsed by Fancy Force / Total Jerkface.
> You need your own copy of Happy Wheels on Steam; the mod runs that copy and contains none of the game's files.

## Install (players)

1. Install **Happy Wheels** from Steam and make sure Steam is running and you're logged in.
2. Download `HappyWheelsMultiplayer-Setup-x.y.z.exe` from the [Releases page](https://github.com/BLUNT-Chief/happywheels-multiplayer/releases/latest) and run it.
   - Windows may show "Windows protected your PC", because the installer isn't code-signed yet. Click **More info → Run anyway**.
3. Follow the setup wizard and leave **Launch Happy Wheels Multiplayer** ticked at the end.
4. From now on, start the game from the **Happy Wheels Multiplayer** shortcut (desktop or Start menu), **not** the normal Happy Wheels shortcut. The normal one starts the regular game, which has no multiplayer menu.

When it starts, a small launcher window checks for updates, finds your Happy Wheels install, links Steam's Play button (below) and checks Steam, then opens the game. If something is wrong (Steam closed, game not installed, the regular Happy Wheels already open) it tells you and offers a button to fix it.

It installs just for your Windows user (no admin rights needed) and never modifies the Happy Wheels install. It uses the same settings as the regular game (controls, options, fullscreen, login), so nothing resets.

## Playing

Open **Happy Wheels Multiplayer**. It looks like the normal game, plus a **MULTIPLAYER** button in the top-right corner (or press **F2**).

**Host a race**
1. Click **Create lobby**. Choose whether it's listed publicly, friends only (not listed) or private (Steam invite only).
2. Click **Invite Steam friends**, or click **Copy** next to the lobby code and send it to them.
3. Click **Choose level…**: browse **Featured**, **Player levels** (search, sort, pages) or **Multiplayer maps** (levels made for racing, see below), or enter a **Level ID**. Then choose whether players collide, and optionally force everyone onto the same character.
4. Optional: pick a difficulty and click **Add AI racer** (see below), and set the **Race rules**: mode (race or survival), collisions, character, finish window.
5. Click **Start race**. Everyone loads the level and waits at the start line, then the countdown runs and it's GO. The host doesn't need to click ready; the panel shows how many players are. Tick **Start automatically when everyone is ready** and the race starts by itself once every player is ready.

**Join a race**: pick a lobby from the list, or paste a lobby code and click **Join by code**. Choose your character and click **I'm ready**. Lobbies can be joined mid-race: open the panel and click **Join race in progress** to jump in (the race clock counts from everyone's GO).

**During a race**
| Key | Action |
| --- | --- |
| Arrows, Space, Shift, Ctrl, Z | Normal Happy Wheels controls |
| **R** | Restart from your last checkpoint, or the start line (the race clock keeps running) |
| **1** to **6** | Quick chat: GG!, Nice!, Oops…, Wait for me!, LOL, Go go go! (shows above your racer) |
| **Tab** / **Shift+Tab** | Once you've finished (or are out): watch the other racers. **Backspace** goes back to you |
| **Esc** | Pause: skip the level or end the race (host), vote to skip (everyone else) |
| **F2** | Open or close the lobby panel |

The timer and standings are at the top. When the first racer finishes, everyone else gets a finish window (45 s by default, host setting) before the results screen appears. From there the host can **Race again**, **Choose level**, pick a **Random** featured level this lobby hasn't raced yet, or start a **Vote**: everyone picks one of three random levels and the most popular is raced next. Tick **Vote for the next level after each race** to do that automatically.

**Stuck or bored of a level?** Press **Esc** to pause: the host gets **Skip to a random level** and **End race now**; everyone else gets **Vote to skip**. Once half the racers vote, the lobby moves on to a random unplayed level. The same buttons are in the F2 panel during a race.

**Left a race?** Exiting to the main menu counts as a DNF, but you can get back in while it's still running: press **F2** and click **Rejoin race**. The host can also click **Back to lobby** (during a race or on the results) to send everyone back to the menu with the lobby open.

**Game modes**
- **Race**: fastest to the finish. On maps with a time limit, racers who haven't finished are ranked by how far they got.
- **Survival**: the last racer alive wins, and there are no restarts. Pick it in **Race rules**, or a map can set it.
- **Cups**: open a level's details and click **Add to cup** for 2 to 8 levels, then **Start cup**. Every race scores points (10, 8, 6, 5, 4, 3, 2, 1 for 1st to 8th), the results show **Next race**, and the best total after the last race wins the cup.
- **Session standings**: the lobby keeps a points table for every race you've played together.

**Host tools**: click **⋯** next to a player to **Make host** (hand over level choice, race controls and AI racers) or **Remove** them from the lobby (they can't rejoin it). **Lock lobby** stops anyone new from joining, while players who were already there can still come back.

**On your own**: open **Choose level…**, pick any level and click **Practice** to race a ghost of your personal best, no lobby needed. Every run where you beat your time is saved. **📊** at the top of the panel shows your personal bests and career stats (races, wins, podiums, cups won and more), and **⚙** has settings: ghost visibility, name tags, HUD size, quick chat keys, checkpoint markers, and **Report a bug**.

**AI racers**: the host can add up to 7. They drive real runs that other players uploaded for the level, so they play like people do, crashes and all. Each run is checked before the race to make sure it still reaches the finish in this version of the game, and the player whose run it is gets credited in the lobby. Difficulty picks the kind of run: **Easy** is slower than a typical run, **Medium** is typical, **Hard** is quick, **Expert** is the fastest run that still works, and a harder AI racer is never slower than an easier one in the same race. AI racers get their runs ready in the background as soon as the host picks a level (the lobby shows *finding a run…*, then who the run is by), so starting the race doesn't wait; if one isn't ready a few seconds after everyone else, the race starts anyway and it starts behind. After finishing, AI racers become see-through and roll to a stop. AI racers can only race levels people have uploaded replays for (featured and popular levels have plenty); on a level without any, they sit the race out and say so. Pick **Your best** as the difficulty and the AI racer drives the host's own best run on the level, which works on brand-new maps too. They run on the host's game, so they leave if the host leaves. With collisions on they're solid like everyone else: a hard hit knocks an AI racer over, it gets itself back upright onto its route where it was hit and carries on, and the time that took counts against it. Everyone sees the same thing.

**Collisions**: with collisions off, other racers are see-through and never touch you or anything in your level. With collisions on, everyone passes through each other at the start line (and after a restart) and becomes solid once you've separated, so nobody gets launched at the start.

**Steam's Play button.** The launcher sets up Happy Wheels in your Steam library to open Multiplayer, so pressing **Play** in Steam just works, with the Steam overlay and **Invite friends** window, and accepting an invite drops you straight into the lobby. Steam only saves this while it's closed: if Steam is closed when the mod starts it happens automatically, otherwise the launcher asks once and restarts Steam (about 20 seconds). If you already had your own launch options for Happy Wheels, it asks before replacing them. Uninstalling the mod puts Steam's Play button back to the normal game. To turn it off yourself, clear Steam → Happy Wheels → Properties → Launch Options and pick **Don't ask again** in the launcher.

## Making multiplayer maps

Anyone can make maps for racing with the normal Happy Wheels level editor. Add **text boxes** that start with `#mp` to set start positions, checkpoints, laps, your own finish line and rules that override the lobby's settings:

| Text box says | What it does |
| --- | --- |
| `#mp spawn 1`, `#mp spawn 2`, … | Start positions. Racers are spread across them. |
| `#mp checkpoint 1`, … | Checkpoints: R respawns you at the last one. Numbered ones must be passed in order. |
| `#mp finish` | Your own finish line (replaces the level's). |
| `#mp laps 3` | A circuit: checkpoints in order, then the finish, three times. |
| `#mp collisions on` / `off` | Whether racers collide on this map. |
| `#mp character segway` | Everyone races as this character. |
| `#mp time limit 3:00`, `#mp finish window 60` | How long the race lasts, and how long others get after the first finish. |
| `#mp restart checkpoint` / `start` / `off` | What R does. |
| `#mp mode survival` | Last racer alive wins. |
| `#mp ai off`, `#mp ai max 3`, `#mp countdown 5`, `#mp ghosts 30`, `#mp players 4` | AI racers, countdown length, ghost visibility, intended lobby size. |

Put **HWMP** in the level name so it shows up under **Multiplayer maps**, then check it with **Test map** (in the level's details), which draws every marker and lists any mistakes. The in-game reference is under **⚙ → Making multiplayer maps**.

**[Read the full map making guide](docs/MAP_MAKING.md)**: templates, every rule, testing, AI racers and tips.

## Troubleshooting

- **"Steam is not running"**: start Steam, log in, then restart the mod.
- **Can't see a friend's lobby**: friends-only and private lobbies aren't listed. Ask for the lobby code.
- **"Other version"** next to a lobby: one of you is on an older mod version. Restart the mod to finish updating.
- **A "game v…" badge** next to a player: their Happy Wheels version differs from yours. Update the game in Steam; different versions can have different physics.
- **"Multiplayer could not start with this version of Happy Wheels"**: a game update changed something the mod relies on. The game still works normally, and a mod update will fix it.
- **No desktop shortcut?** Open MULTIPLAYER and click **Create desktop shortcut** (the launcher also offers one if you skip Steam's Play button).
- **Chat** is in the lobby panel (Enter sends). Messages that arrive while the panel is closed pop up at the bottom of the screen.
- **Logs**: `%APPDATA%\HappyWheelsMP\logs\hwmp.log`. Please attach this file to bug reports, from everyone involved. **⚙ → Report a bug** opens a new GitHub issue and the log folder for you.

---

## Privacy

Happy Wheels Multiplayer has no servers of its own and collects no analytics or telemetry. It only connects to:

- **Steam**, to create and join lobbies, show player names and avatars, and send race data to the other players in your lobby.
- **GitHub**, to check for and download updates to the mod.
- **totaljerkface.com**, the Happy Wheels server, for levels, level lists and replays (the game itself uses it the same way).

Logs stay on your PC (`%APPDATA%\HappyWheelsMP\logs`) unless you choose to share them.

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org). (Signed releases start once SignPath has reviewed the project; until then the installer is unsigned.)

- Committers and reviewers: [BLUNT-Chief](https://github.com/BLUNT-Chief)
- Approvers: [BLUNT-Chief](https://github.com/BLUNT-Chief)

Releases are built from this repository by GitHub Actions (`.github/workflows/release.yml`); only those builds are signed.

**Verify a download.** Installers released after v0.2.0 come with a signed build provenance attestation (Sigstore, published through GitHub), which proves the file was built by this repository's release workflow from the public source. With the [GitHub CLI](https://cli.github.com):

```
gh attestation verify HappyWheelsMultiplayer-Setup-x.y.z.exe -R BLUNT-Chief/happywheels-multiplayer
```

## How it works (developers)

Happy Wheels on Steam is an Electron app. Its `app.asar` is protected by Electron's asar-integrity and only-load-from-asar fuses, so it can't be patched in place, and patching would also break on every Steam update. Instead the mod is **its own Electron app** (pinned to the game's Electron version) that boots the player's installed copy of the game:

```
src/main/        main process
  index.js         startup flow (launcher steps), IPC, logging
  launcher.js      launcher window: progress steps and fix-it prompts
  preflight.js     Steam / regular-game checks, saved settings
  gameLocator.js   finds the Steam install (registry + libraryfolders.vdf)
  gameHost.js      loads the game's own main.js from its app.asar, serves its webroot,
                   injects our script into the game page, captures the Steam client
  steamNet.js      Steam lobbies + P2P packets (the game's own steamworks.js build)
  netIpc.js        validated IPC surface used by the page
  updater.js       electron-updater (GitHub Releases)
  log.js           file log
  localNet.js      DEV ONLY: localhost relay that stands in for Steam (multi-instance testing)
  devBridge.js     DEV ONLY: remote control for automated testing (never packaged)
src/launcher/     launcher window page
src/preload/     narrow window.hwmp API for the page
src/renderer/    runs inside the game page (bundled to out/web/inject.js)
  hooks.js         hooks the game's webpack chunk array; finds Box2D/PIXI by prototype shape
  game/locate.js   finds game classes (Session, SessionController...) by method names
  game/bridge.js   load level by id, freeze at the start line, session/restart/finish events
  game/character.js body layout, state sampling, gore-event capture
  game/puppets.js  remote racers: real game characters driven by network state
  game/mapTags.js  multiplayer map tags (#mp text boxes) and their warnings
  game/replays.js  AI racers' runs: replay lookup (rate-limited), off-screen check, cache
  game/runs.js     personal bests: records your runs, keeps the best one per level
  net/protocol.js  wire format (binary body state + validated JSON control messages)
  net/clock.js     host-synced race clock
  net/race.js      lobby and race state machine (host-authoritative control)
  net/bots.js      AI racers (host side): run hand-out, playback, knock-over and recovery
  net/scoring.js   rankings and points, shared by results, cups, standings and stats
  net/cup.js, vote.js, hostTools.js   cups, level votes, kick/lock/host hand-over
  net/solo.js      practice against your ghost, map test mode
  net/stats.js     career stats (local)
  ui/              lobby, HUD, results and settings overlay (shadow DOM)
```

Key techniques:
- **No game code is patched.** The game's bundle is obfuscated, so the mod wraps its webpack module factories at runtime to reach the classes, then identifies them by prototype shape (e.g. a class with `CreateBody` + `Step` is Box2D's `b2World`). That survives rebuilds that reshuffle module IDs and minified names.
- **Remote racers are puppets.** The game's own `setupCharacter` builds a real character for each remote player. Its bodies are then moved to the interpolated network state every frame (100 ms playout buffer), and the game's own `paint()` draws them. Break and smash calls such as `neckBreak(impulse)` are captured on the local character and replayed on its puppet, so gore matches.
- **Collisions** come from a Box2D contact filter. Puppets never touch each other, sensors or loose level objects, and they only hit the local player when collisions are on and the two have separated after spawning.
- **Race timing** uses a host-synced clock (ping round trips, keeping the lowest-latency samples). Times are measured from the shared GO instant, and the timebase survives host migration.

### Develop

Requires Windows, Node 22+, Steam, and Happy Wheels installed.

```bash
npm install
./scripts/dev.sh            # run with the dev bridge on 127.0.0.1:47800
./scripts/dev-duo.sh        # two instances ("Alice" and "Bob") that race each other locally, no second Steam account needed
node scripts/dev-eval.js -e 'return window.__hwmp.mp.phase'   # evaluate JS in the running page (add --port 47801 for Bob)
```

Dev-only switches (ignored by installed builds): `HWMP_LOCAL_NET=1`, `HWMP_MULTI=1`, `HWMP_PROFILE=n`, `HWMP_NO_STEAM=1`, `HWMP_NAME=…`, `HWMP_DEV_PORT=…`, `HWMP_GAME_DIR=…`, `HWMP_OFFSCREEN=1` (test windows park off-screen and never take focus), `HWMP_FAKE=nogame,nosteam` (preview the launcher's problem screens).

### Release

1. Add the release's highlights to `src/renderer/ui/changelog.js` (players see them once after updating), with the exact version you're about to release. Then `npm version patch` (or `minor`) and `git push --follow-tags`.
2. The **Release** GitHub Action builds the installer and publishes it to GitHub Releases. Everyone's installed mod downloads it in the background and asks to restart (or updates on next quit).

Local build without publishing: `npm run dist` → `dist/HappyWheelsMultiplayer-Setup-x.y.z.exe`.

**Code signing (optional)** removes the SmartScreen warning. Add a base64-encoded `.pfx` as the repository secret `WIN_CSC_LINK` and its password as `WIN_CSC_KEY_PASSWORD`; the release workflow picks them up. Azure Trusted Signing is a cheaper alternative supported by electron-builder.

When the wire protocol changes incompatibly, bump `PROTOCOL_VERSION` in `src/main/steamNet.js` so old and new versions refuse to share a lobby.
