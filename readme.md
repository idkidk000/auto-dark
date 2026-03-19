## Auto dark for KDE and GTK

Automatically switch KDE or GTK themes and colour schemes according to HomeAssistant binary sensors

Everything's built on abstract base classes so it would be trivial to support a different sensor source or DE/WM

Most settings are at the top of the script for simplicity. Sensitive settings (`HASS_URL` and `HASS_TOKEN`) should be
provided through environment variables or a `.env` file

### Requirements

- A HomeAssistant instance with some sort of ambient light sensor
- An OS running KDE or a GTK-based DE
- Deno

### Installation

- Add two binary sensors to Home Assistant, i.e. `binary_sensor.is_light` and `binary_sensor.is_dark`. Set them to be
  active according to your preferences. I like to keep a large dead zone where neither is active to prevent hysteresis
- Create a `Long-lived access token` in Home Assistant
- Add `HASS_URL` and `HASS_TOKEN` to a `.env` file
- Edit the `constants` region at the top of the script per your preferences
- `deno i`
- Add `auto-dark.sh` (not `auto-dark.ts` directly) as a login script or run `auto-dark.ts -tui` in a a terminal

### Args

- `-tui`: Enable the TUI
- `-no-tui`: Disable the TUI (default)

### TUI commands:

- `a`: set dark/light according to sensor (auto)
- `d`: set dark
- `l`: set light
- `s`: show sensor dark state
- `1|2|3|4|5`: adjust log level between `Trace` and `Error`
- `q|ctrl+c`: quit
- `h|?`: list TUI commands
