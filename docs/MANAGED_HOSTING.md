# Managed hosting with Render

This setup runs TransitLens as one managed web service without Docker.
Render builds the existing frontend, installs both Python services and supplies a public HTTPS URL.
Only the web gateway is public; bus and voice APIs listen on loopback and are reached through its same-origin proxy.

The root `render.yaml` selects the Free instance in Virginia and disables automatic redeploys.
The build command is `bash scripts/build-managed.sh` and the start command is `python scripts/serve-managed.py`.
Node is pinned to 24.21.0 and `.python-version` selects Python 3.13.
Both tools are available in Render's [native runtimes](https://render.com/docs/native-runtimes).

## First deployment

1. Add the Render integration and sign in to the intended workspace.
2. Give Render access to the private `acheng2007/swamphacks` repository.
3. Publish the verified current app and this configuration to a deployment branch, then create the Render service from that branch's Blueprint.
4. Set `RTS_API_KEY` and `GEMINI_API_KEY` as server-side secrets when Render prompts.
5. Deploy, wait for `/healthz` to pass, and verify live buses and Gemini through the resulting HTTPS URL.
6. Open that URL on the phone and test camera, motion, microphone and casting.

Do not substitute the current GitHub main branch until the uncommitted app changes have been published.
The local Cloudflare tunnel stays available during this process.
The permanent URL comes from Render after the service is created; no permanent URL has been provisioned merely by adding these files.

Render supplies `PORT` and `RENDER_EXTERNAL_URL` automatically.
The launcher starts both APIs, waits for readiness and starts the public gateway.
It stops all children on shutdown or if any child exits, allowing the host to restart the complete service.
API keys are passed only to their respective API process, not the gateway.
There is no application database or migration step.

The [Free instance sleeps after 15 idle minutes](https://render.com/docs/free) and typically takes about a minute to wake.
An always-on instance is an optional paid change, not part of this default setup.
Provider quotas, ephemeral speech/cache state and the existing single-pair casting limitation remain as documented in [deployment notes](DEPLOYMENT.md).
