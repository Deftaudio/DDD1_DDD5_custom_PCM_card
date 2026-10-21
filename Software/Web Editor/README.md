# DDD ROM Tools

Browser replacement for the Windows "Korg DDD Expansion Sound ROM Creator v0.5"
scripts (`Deftaudio_MAIN.bat`, `Deftaudio_PicoROM_Process_1x…8x.bat`, SoX).
Runs locally in Chrome/Edge; no install.

## Run

Open `index.html` directly (double-click, or drag it into Chrome/Edge); no web
server is needed. Everything, including PicoROM programming over Web Serial,
works from `file://` in desktop Chrome or Edge. Other browsers can convert and
export, but cannot talk to the PicoROM.

One difference from file://: Chrome does not let a page opened from disk read
folders dropped onto it. Dropping files works everywhere; for a `[WAV_IN]` or
`BankN` folder use **Open folder…** (or serve the page, where folder drops work).

To host it instead, any static server works, e.g.
`python3 -m http.server 8765 -d ddd_editor` (Web Serial then needs HTTPS or localhost).

## Files

- `js/ddd_rom.js`: ROM format (header, layout, PicoROM image order) and the
  SoX-equivalent conversion. No DOM, so it is testable in Node.
- `js/ddd_app.js`: user interface, import/export, PicoROM.
- `js/picorom.js`, `wav.js`, `aiff.js`, `flac.js`, `resample_sinc.js`,
  `jszip.min.js`: shared with the Luma tools.
- `test/test_rom.js`: `node ddd_editor/test/test_rom.js` checks the generated
  headers against the 1X…8X template files in the scripts' `tools/meta` folder.
