# Kinetiq

An original, self-hosted multiplayer game platform — website, accounts, creator editor, dedicated game
servers, a 3D game client, marketplace, social graph, moderation tooling, and developer APIs.

Kinetiq is **not** affiliated with, derived from, or built using any Roblox source code, assets, or
trademarks. Every line of code, every UI graphic, and every asset in this repository is original.
The platform name is a single configuration value (`platform.config.json` → `platformName`).

```
npm install
npm run dev          # website + API + matchmaking + realm host + static client/editor
```

Then open the live preview (or `http://localhost:3000`).

## What runs

| Application | Entry point | Purpose |
|---|---|---|
| Website + API gateway | `apps/web/src/index.js` | Accounts, discovery, profiles, social, marketplace, admin, developer API |
| Realm host (game servers) | `apps/server/src/host.js` | Spawns/hosts authoritative game server processes |
| Game client | `apps/web/public/client` | 3D client: renders worlds, runs client scripts, talks to realms |
| Creator editor (Forge) | `apps/web/public/editor` | Visual 3D world editor, explorer, properties, script editor, play test |
| Launcher / updater | `apps/launcher/src/index.js` | Install, verify, repair, incremental update, rollback, launch |
| Admin console | `apps/web/public/admin` | Server-side authorised moderation & operations dashboard |

## Documentation

- [`docs/getting-started.md`](docs/getting-started.md)
- [`docs/scripting.md`](docs/scripting.md)
- [`docs/objects.md`](docs/objects.md)
- [`docs/networking.md`](docs/networking.md)
- [`docs/ui.md`](docs/ui.md), [`docs/player-data.md`](docs/player-data.md), [`docs/assets.md`](docs/assets.md)
- [`docs/architecture.md`](docs/architecture.md), [`docs/security.md`](docs/security.md)
- [`docs/game-format.md`](docs/game-format.md), [`docs/publishing.md`](docs/publishing.md), [`docs/debugging.md`](docs/debugging.md)
- [`docs/api.md`](docs/api.md)

## Tests

```
npm test
```
