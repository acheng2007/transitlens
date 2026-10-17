# Current TransitLens web checkpoint

Use [the root setup instructions](../README.md) for the live RTS Cardboard app and [verification record](../docs/LIVE_RTS_VERIFICATION.md) for current support limitations.
The default data source is `/api/buses/nearby` through the Vite proxy to bus-service on port 8003.
`?dev=1` uses live buses around fixed Reitz Union with keyboard heading controls.
The former `?data=fixture`, aircraft simulation, virtual-sky, and voice entry points are disabled in this web checkpoint.
Camera/stereo/calibration/casting infrastructure remains shared with the imported code.

The following upstream reference describes the original aircraft app and is retained for calibration and provenance.
Its aircraft data, product defaults, voice configuration, and provider instructions are historical.

# web/ — owner: Jaiden

Vite + TypeScript web app (camera, stereo view, heading, HUD, cone filter, integration).
`web/src/voice/` is owned by **Allison**. See root `CLAUDE.md` for contracts and rules.

## Run

```sh
npm install
npm run dev              # http://localhost:5173
ngrok http 5173          # HTTPS URL to open on the phone (needs ngrok >= 3.20)
```

`/api/flights` and `/api/voice` are proxied to ports 8001 / 8002, so one tunnel covers everything.

## Casting to a laptop (judges / demo recording)

1. On the phone's start screen, check **Cast to laptop**, then Start.
2. On the laptop running `npm run dev`, open `http://localhost:5173/cast.html`.

It connects within a few seconds (peer-to-peer WebRTC; phone and laptop need to reach each other, e.g. same Wi-Fi).
**Record** saves a `.webm` of the stream (key `R`), `H` hides the control bar. If the network blocks it, use `scrcpy` over USB.

## Stereo layout

Each eye's image is centered under its Cardboard lens (default 64 mm apart), not at 1/4 and 3/4 of the screen.
That needs CSS px per mm, which comes from a per-phone preset in `src/config.ts` (auto-detected, overridable on the start screen).

| Phone | Screen long edge | Landscape viewport (approx) |
|---|---|---|
| Pixel 10 | ~146 mm | ~924 × 412 |
| Galaxy S22+ | ~152 mm | ~832 × 384 |
| iPhone 13 mini | ~125 mm | — (iOS: no fullscreen/orientation lock) |

## In-headset calibration

Calibration is locked by default. **Double-tap the middle** to unlock; then tap the **middle** to cycle settings, **left/right** to adjust. Re-locks after 6 s idle. Saved per browser. **Long-press** returns to the start screen.

| Setting | What it fixes |
|---|---|
| zoom | Hardware camera zoom (starts at widest). Tune until things look life-size. |
| tilt | Phone sitting crooked in the headset → double crosshair. Rotates the layout. |
| spacing | Lens center distance (default 64 mm). Crosshairs side by side → adjust. |
| shift | Phone off-center horizontally in the headset. |
| size | Shrinks the image if the edges look warped. |
| fov | Field of view used to place planes. Tune until diamonds line up with real objects as you turn. |
| info | Shows all current values. |
