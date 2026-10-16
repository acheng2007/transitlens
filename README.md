# TransitLens

TransitLens is an augmented reality interface for Gainesville RTS buses.
Point a phone toward the street and see nearby buses at their real geographic bearings, identified by route and destination.
Look directly toward a bus to reveal its information card.

**Google Cardboard is the primary experience.**
The phone shows the rear camera and matching HUD overlays in both eyes while device orientation lets the rider look around naturally.
Mobile AR is a secondary, full-screen view powered by the same tracking state.

## What we are building

```text
Choose Cardboard + Live RTS
            |
Grant camera, orientation, and location access
            |
Put the phone in the headset and look around
            |
See bus markers at their geographic bearings
            |
Hold your gaze toward a bus to reveal route details
```

The core MVP is simple: **live Gainesville buses appear at approximately correct real-world bearings while the user looks around through Google Cardboard.**
This is geographic AR: phone GPS, bus GPS, and camera heading determine where labels appear.
Computer vision, SLAM, ARKit, and ARCore are not dependencies.

A focused bus card identifies the route and destination, distance, and available vehicle information.
Speed, delay status, and passenger load may be missing and must degrade gracefully.
Arrival times will only appear when backed by prediction data; distance and speed alone are not an arrival prediction.

Demo mode is a first-class experience.
It uses 8-15 synthetic buses around a fixed UF / Reitz Union location, ignores live GPS, and keeps live phone orientation.
It must operate without an RTS connection.
Desktop development supports the fixture, keyboard heading controls, a heading slider, and a camera-free background.

## Current status

This repository currently contains planning documents only.
Implementation is paused until the team is ready to begin.
No application source has been imported or modified here, and there is no local app startup command yet.

We will adapt its aircraft experience to buses while preserving its working camera, stereo layout, device orientation, heading smoothing, geographic math, pinhole projection, calibration, and casting infrastructure.
Its web production build passed, but browser, physical phone, and headset behavior have not been verified.
The baseline verification milestone remains open.

## Documents

- [Product requirements](docs/PRD.md): the supplied product specification and first implementation milestone.
- [Implementation roadmap](docs/ROADMAP.md): ordered milestones, acceptance gates, source file migration map, and contributor workflow.

Use the PRD for intended product behavior and the roadmap to choose the next bounded task.
When a milestone lands, update its status and record what was actually tested.

## Architecture direction

```text
RTS / BusTime API             Local Gainesville fixture
       |                               |
Server-side bus-service                 |
       |                               |
GET /api/buses/nearby                   |
       +---------------+---------------+
                       |
              Shared bus tracking state
       GPS + heading + bearings + focus selection
                       |
           +-----------+-----------+
           |                       |
   Cardboard renderer       Mobile AR renderer
   two camera/HUD views     one camera/HUD view
```

Bus positions refresh from the feed at a controlled interval.
Overlay positions update every animation frame using the latest heading.
Both eyes, casting, and eventually mobile AR consume the same tracking and focus state.
Renderers must not independently select targets or maintain their own feeds.

External RTS calls happen only on the server.
`RTS_API_KEY` must never enter browser code, client environment variables, logs, or committed configuration.
The live integration and exact available RTS fields must be verified before implementation.

## Contributing

Start with baseline verification, then implement the local bus demo before changing the live service.
The first implementation checkpoint is a bus model, Gainesville fixture, and bus-focused Cardboard HUD.
Stop and verify that checkpoint before starting live data work.

Preserve existing orientation transforms, smoothing, projection, and Cardboard calibration unless a reproduced problem requires a focused change.
Account for the Android wrapper, which imports shared web modules, when changing their interfaces.
Keep demo mode operational at every milestone.
Do not invent arrival predictions or show fabricated demo vehicles as live RTS data.

Make changes in reviewable units with explicit acceptance criteria.
Reproduce bugs through the user-facing flow before editing code, and verify the result in that flow afterward.
Record hardware-only checks as pending when the required phone, headset, or outdoor test is unavailable.
Stretch features begin only after the live Cardboard acceptance gate passes.

The roadmap prioritizes product quality, robustness, and maintainability over minimizing implementation effort.
It keeps the scope ordered so contributors and AI agents can build incrementally without destabilizing the primary experience.
