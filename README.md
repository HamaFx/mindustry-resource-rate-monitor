# Resource Rate Monitor

Shows how fast each core resource is being produced or consumed, plus your power balance, right in the HUD.

Fork of [derekShaheen/Mindustry-Resource-Rate-Monitor](https://github.com/derekShaheen/Mindustry-Resource-Rate-Monitor)
(MIT, by Skrip) with mobile and iOS support, a power row, a display toggle and a rewritten rate sampler.

## Features

- Per-resource amount and rate, for example `1.5k(+120)` or `400(-12)`
- Rate colors: gaining, losing, stable
- `(!)` low-stock warning when a resource has under 10 seconds of supply left
- Flicker detection for resources that are consumed as fast as they arrive (`~0`)
- Power row with production, consumption and the net balance, plus a shortage warning
- Eye button hides or shows the readout, and the choice is remembered
- List button cycles the column count (4 to 8)
- Compact number formatting (1.5k, 2.3M, 12.4B)
- Works on desktop, Android and iOS

## Platforms

The mod shows up in the same place as the vanilla core resource list on desktop. On mobile
(Android and iOS) the vanilla core list is collapsed by the game, so the mod adds its own
table below the wave panel instead. Placement follows the HUD, so it stays correct in
landscape and portrait and clears the safe area on notched devices.

## Installation

Desktop, Android and iOS builds all have a mod browser in the main menu:

1. Open `Mods` and switch to the browser tab
2. Find `Resource Rate Monitor` and install it
3. Restart the game when prompted

On iOS only mods that declare `iosCompatible: true` are listed, which this mod does. Mods are
JavaScript only on iOS: Java mods cannot load there.

Manual installation works too: download this repository as a zip and import it from the
`Mods` screen, or drop the folder into your mods directory.

## Usage

Once installed and enabled, the readout is automatic.

- **Eye button**: hide or show the readout. The state is saved, so it stays hidden across restarts.
- **List button**: cycle the column count between 4 and 8.

## How it works

Amounts are sampled once per second and normalized by the actual elapsed time, then smoothed
over the last four samples so the numbers do not jitter:

```
rate = (amount - lastAmount) * 1000 / elapsedMilliseconds
```

A resource is shown once it holds at least 5 items, and hidden again at 0. Resources that
keep reappearing below the threshold within 3 seconds are treated as flickering and shown
as `~0`.

Power is summed over every network owned by your team. Production is read per tick, so it
does not depend on the frame rate, the net balance comes from the game's own power graph
average, and consumption is derived from the two so the numbers always agree. A red `(!)`
marks a network running at a deficit.

The table is only rebuilt when the visible item set, the power row or the column count
changes, and label text is cached, so per-frame work stays small on mobile.
