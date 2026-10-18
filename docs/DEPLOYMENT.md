# Deployment preparation

The production setup serves built web assets and same-origin APIs from a Node gateway, with private bus and voice containers.
Vite is used only to build the frontend.
The current Cloudflare quick tunnel remains a separate development/demo link.
No permanent host or domain has been configured by this change.

## Run on a host with Docker Compose

```sh
cp deploy/.env.example deploy/.env
# Edit deploy/.env with the server's RTS_API_KEY, GEMINI_API_KEY and public HTTPS URL.
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
```

The web gateway listens on host loopback port 8080 by default.
`WEB_PORT` changes that port.
The Python services have no published host ports.
Keep `deploy/.env` on the deployment host; it is ignored by Git and excluded from Docker build contexts.
Keys enter their respective services at runtime and are not copied into images or browser assets.

Put an HTTPS reverse proxy or named Cloudflare Tunnel in front of `http://127.0.0.1:8080`.
For a permanent Cloudflare hostname, configure its origin to that local address on the Docker host and set `PUBLIC_URL` to the public HTTPS origin.
An ephemeral test tunnel can use `cloudflared tunnel --url http://127.0.0.1:8080`.
HTTPS is required for phone camera, motion, GPS and microphone behavior.

The web runtime uses Node 24 with built-in TypeScript stripping and requires no runtime npm packages.
The Python images use Python 3.13.
Containers run as non-root users and restart unless stopped.
Compose health checks wait for dependencies; see [Node TypeScript](https://nodejs.org/api/typescript.html) and [Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/).

## Verify before switching traffic

```sh
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/api/buses/health
curl --fail http://127.0.0.1:8080/api/voice/health
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

Health checks establish process readiness and key presence, not upstream RTS or Gemini availability.
Verify actual live buses, one grounded voice request, phone permissions and casting over the public HTTPS hostname separately.
No automatic provider-inference health checks consume quota.

Use one instance of each service and one Python worker.
Voice speech identifiers, request deduplication, provider budgets, transit caches and casting signaling are process-local.
Restarts lose ephemeral session data and cached audio.
The current cast relay supports one active wearer/viewer pairing per instance; unrelated simultaneous users need session-scoped authorization before sharing casting infrastructure.
It expires signaling after two minutes and limits request size.
WebRTC still uses direct peer connections with STUN; TURN or a managed media relay remains a separate cross-network acceptance item.

Rollback by rebuilding the chosen earlier source revision and restarting this same Compose deployment.
The deployment has no persistent application database to migrate.
Keep credentials in the host's ignored environment file while changing source revisions.

## Fixture-only container smoke test

Build production images without real credentials:

```sh
docker compose --env-file deploy/.env.example -f deploy/compose.yaml build
WEB_PORT=8088 docker compose -p transitlens-smoke --env-file deploy/.env.example -f deploy/compose.yaml -f deploy/compose.smoke.yaml up -d --no-build --wait
node scripts/smoke-production.mjs
docker compose -p transitlens-smoke --env-file deploy/.env.example -f deploy/compose.yaml -f deploy/compose.smoke.yaml down
```

The smoke override explicitly clears both provider keys and uses the production images built by the first command.
The test uses fixed public demo coordinates, scripted commands and a disposable cast offer.
Run it against this isolated smoke stack, not an instance with someone's active casting session.

## Verification recorded October 17, 2026

- All three production Docker images built successfully.
- The fixture-only container smoke passed for HTML, hashed assets, manifest, cast page, health checks, demo buses, local map actions and offer/answer signaling.
- The production HTTP integration test covers private-file and symlink blocking, body limits, invalid/stale signaling, audio proxying, cache policy and upstream failure.
- All 47 web tests and 43 bus-service tests passed; the web production build passed.
- Real provider credentials in containers, a permanent hostname, physical iPhone acceptance and cross-network media acceptance remain pending.

DeepSpace was evaluated separately in [the research note](DEEPSPACE_RESEARCH.md).
It has not been added to this deployment.
