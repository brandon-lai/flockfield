# Flock

**A shared browser pasture where every visitor gets one sheep, tied to their device, living on one plain with everyone else's.** The sheep wander, graze, nap and play on their own. Yours earns EXP for every minute the tab is open and in view. Tap any sheep to see which country its owner is in.

- Pasture: https://flockfield.vercel.app
- Realtime server: the `flockfield` Cloudflare Worker (URL in [The state of it](#the-state-of-it))

## How it's built

```
client/   Vite + TypeScript + three.js. Instanced sheep, all posing in the vertex shader.
server/   Cloudflare Worker + one Durable Object (SQLite storage) that owns the flock.
shared/   Code both sides run unchanged: the behaviour sim, world map, levels, protocol.
tests/    Unit tests (shared/) and integration tests against a real `wrangler dev`.
```

The server owns the truth (PRD "Technical architecture"). The Durable Object ticks the behaviour state machine at 2 Hz while anyone is connected and sends **intents** (`{ state, from, to, startAt, duration, face, variant }`), never positions. Clients interpolate with the same `intentPosition()` the server uses and pose every sheep locally, so two screens show identical motion for the cost of one small message per behaviour change. Each socket subscribes to 50 × 50 chunks around its viewport and only hears about sheep in them.

The offline mode (`?offline=1`, or no `VITE_PASTURE_URL`) runs the same `Pasture` class in the page. It says "Offline pasture: not shared, nothing is saved" and earns nothing. It exists for building and judging the scene, not to pretend to be shared.

### Run it

```bash
npm install && (cd server && npm install)
cd server && npx wrangler dev --port 8787          # needs server/.dev.vars with IP_HASH_SECRET=anything
echo 'VITE_PASTURE_URL=http://localhost:8787' > .env.local
npm run dev                                         # http://localhost:5199
npm test                                            # shared unit tests
npm run test:server                                 # spins up its own wrangler dev on :8799
```

Useful URL parameters, offline only: `?flock=1000` (stress test), `?level=12` (see growth), `?phase=0.7` (see night).

## Decisions

The PRD let me swap pieces "if there is a strong reason". Where I did, this is the reason.

| Decision | Why |
| --- | --- |
| **Name: Flock**, served at `flockfield` | The working title is short and exactly right, so I kept it. `flock.vercel.app` is taken; `flockfield` names the place. |
| **Client on Vercel, server on Cloudflare** | Vercel can't hold a WebSocket or run a 2 Hz tick, which is what the PRD's realtime design needs. Durable Objects can, so the backend follows the PRD. The static client deploys from GitHub like every other project here. |
| **Durable Object SQLite instead of D1** | It's the same SQLite engine, held by the object that runs the sim, so there's no second binding and no flush lag between the simulation and its records. It's on the free plan. Sharding later means one object per chunk range, each owning its own sheep. |
| **Raw three.js, no React Three Fiber** | The whole flock is about 12 instanced draws whose attributes I write by hand every frame. R3F would add a reconciler and nothing else here. |
| **Pose on the CPU, motion on the GPU** | Per sheep, the CPU picks ~20 numbers (heading, hop, squash, lie-down, head pitch/yaw, blink); the vertex shader bends legs, flops ears, wiggles the tail and breathes. This costs about 1 ms of JS for 1,000 sheep and needs no skeletons. |
| **LOD as a dithered cross-fade** | Near sheep get faces, ears, legs and accessories; far ones are a wool blob with a head. In the band between, the two batches draw complementary dither cells, so nothing pops and nothing goes see-through. |
| **Wild sheep keep a 40-sheep floor** | On launch day the pasture would otherwise be one lamb on an empty plain, which fails "the pasture feels alive". Wild sheep have no owner, and their card says so ("A wild sheep: nobody's sheep, yet"), so no country is invented. They leave one for one as real sheep arrive. |
| **EXP banks wall time between heartbeats** | Each heartbeat from the earning tab banks the time since the previous one, provided the gap is short enough that the tab was visible throughout (45 s). Every 60 s banked is 1 EXP. Because only wall time is banked, no rate of heartbeats can beat 1 EXP per minute, and a hidden stretch earns nothing. |
| **One earning tab** | The first tab for a sheep earns. If it goes quiet (hidden) for 45 s, a visible tab takes over. Other tabs render normally and show "Your sheep is being watched in another tab." |
| **Feed cooldown 2 min, pet cooldown 4 s** | Feeding uses the PRD's suggestion. Petting isn't specified; 4 s keeps it a moment rather than a clicker. |
| **Sound is synthesised** | Wind, birdsong, night crickets, distant bleats and the baa are WebAudio, with no audio files to license or download. It's off by default on mobile; on desktop it fades in on the first interaction. |
| **First-visit drop waits for shaders** | The lamb drops in when the server hears `hello`, so the client compiles every shader first. On a slow phone the drop would otherwise play behind the loading screen. |
| **Tree collision covers the canopy** | From a 56° camera, a sheep under a tree is a sheep you can't see. |

## Open questions, answered

| Question | Shipped answer | Reason |
| --- | --- | --- |
| **Offline sheep** | They stay. After **30 days** without their owner they rest in the barn: kept in storage, not loaded into the pasture. They come straight back when the owner returns. | It keeps the plain from filling with absent sheep without ever deleting anyone's sheep. |
| **What "active" means** | **Tab visible only.** | The product is "a calm, ambient screensaver you want to leave open". Requiring input would punish exactly that. The one-tab rule and the per-minute cap already stop farming. |
| **Feeding reward** | **Purely cosmetic.** | "Time spent is the only progression." A feeding bonus, even a capped one, would make the cooldown timer the progression. |
| **Level cap** | **No cap**, but the look is complete at **30** (bow at 10, bell at 20, flower crown at 30, fluffier wool every 5 levels). | The curve caps itself: level 50 is about 1,100 hours. A hard cap would only matter to someone who has had the tab open for six weeks. |
| **Recovery** | **Accept the loss**, stated plainly in About. | An export code is a way of moving a sheep between devices, which the PRD lists as a non-goal. |
| **Day and night** | **One shared world clock**, one day per real hour (about two-thirds day). | It's one pasture. If your screen says night, the sheep around you should be the sleepy ones, and the server weights sleep by the same clock. |
| **Name** | **Flock.** | See Decisions. |

## Acceptance criteria: where each one stands

How each was checked: **unit** = `tests/shared.test.ts`, **integration** = `tests/server.test.ts` against real `wrangler dev`, **render** = driven in Chrome and the screenshot examined.

**Phase 1**
- Pan and zoom with mouse, trackpad, touch, clamped: implemented (pointer events, wheel, ctrl-wheel trackpad pinch, two-finger pinch) and clamped to the walkable plain plus 13–200 units of zoom. Render-checked with mouse and synthetic pointers. **Not yet tried on a real touchscreen.**
- Behaviour cycle (wander, graze, idle, play, social, sleep): unit (an hour of 150 sheep reaches every state) and render.
- Feeding tray drops each of the 5 foods; the sheep trots over and eats: integration, plus render (carrot).
- Petting plays the lean-in and heart: implemented, and integration covers the server path. Not screenshotted.
- Day and night: render (`?phase=`).

**Phase 2**
- 1,000 sheep at 60 fps on a 2020 laptop: **measured on an M3 Pro, not on a 2020 laptop.** With vsync off at 1080p, 1,000 sheep take 1.7–2.2 ms a frame (~460–580 fps). The worst case I could construct, 3,000 sheep with all 320 near-LOD slots full, takes 3.1 ms. A 2020 integrated GPU is several times slower, so 60 fps is likely but unproven.
- Avoid each other and obstacles, sometimes group up: unit (no destination inside scenery, no path through it, under 0.1% of resting pairs closer than 1.2 units, cohesion toward local groups).
- LOD without popping: render (complementary dither).
- Tap any sheep opens its card: render.

**Phase 3**
- First visit creates a sheep and stores the token (localStorage plus a backup cookie): integration and render.
- Reload returns the same sheep: integration.
- Two browsers see each other's sheep in sync, and each other's feeding: integration (identical intents on both sockets, `fx` delivered to the other one).
- Tap another sheep shows its owner's country: implemented (flag emoji plus `Intl.DisplayNames`). Locally every country reads "Somewhere on Earth" because `wrangler dev` has no `CF-IPCountry`. **Production is where this gets checked.**
- Only chunks near the viewport are streamed: integration (everything streamed lies in subscribed chunks, and moving away despawns it).

**Phase 4**
- EXP only while visible, at most 1 per minute, one tab per sheep: integration, with all three rules tested separately.
- Level-up celebration (sparkle, chime, happy bleat, jump), and the lamb becoming a sheep at level 5: implemented. Growth is render-checked (`?level=4` vs `?level=30`). The celebration itself isn't screenshotted.
- Ambient sound with a toggle, respecting autoplay: implemented. **Nobody has listened to it yet.**
- Registration rate limit (5 per IP per hour, IP stored only as an HMAC and deleted after an hour): integration.
- First-visit hint shows once per device: render.

## The state of it

See the commit log for what verification found and fixed.

**Owner checklist** (things only a person can do):
1. **Play it on a phone and a 2020-era laptop.** Pinch zoom, frame rate, and whether the sound is pleasant or annoying at real volume.
2. **Turn on deploys from GitHub for the Worker.** Vercel deploys the client on every push. The Worker's first deploy was made from a clean export of a commit (see the commit message). For later pushes to deploy it, add a Cloudflare API token as a repo secret, and `.github/workflows/worker.yml` takes over:
   ```bash
   # dash.cloudflare.com → My Profile → API Tokens → "Edit Cloudflare Workers" template
   gh secret set CLOUDFLARE_API_TOKEN --repo brandon-lai/flockfield
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo brandon-lai/flockfield --body 78d3d855efbaa5308c3f0585e34b5d45
   ```
3. Tune by feel: behaviour durations (`shared/sim.ts`), the EXP curve (`shared/levels.ts`), the wild-sheep floor (`WILD_FLOOR`).

`/stats` on the Worker reports connections, live/owned/wild sheep, messages per second and tick cost. Watch it before the single object needs splitting.
