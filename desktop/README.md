# MakeItDrumless Desktop

Tauri 2 + Vite + React + TypeScript + Tailwind desktop interface for the existing MakeItDrumless Python CLI. The Tauri frontend is in `desktop/`; Python generation and library indexing remain in the repository package.

## Development

Prerequisites: Bun, Rust, Python 3.11, `uv`, and the native Tauri prerequisites for your OS.

```sh
uv sync
cd desktop
bun install
```

Build the platform sidecars before starting Tauri. The target triple must match the current platform (`x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, or `x86_64-pc-windows-msvc`):

```sh
cd ..
uv sync --extra desktop-build
target_triple="$(rustc --print host-tuple)"
uv run python scripts/build_desktop_sidecar.py --target-triple "$target_triple"
cd desktop
bun run tauri dev
```

The desktop backend expects the CLI package to be importable from the repository root. Release builds include a lightweight frozen worker, the full `makeitdrumless` CLI, and a bundled FFmpeg sidecar. The worker calls the sibling CLI for generation so everyday library and waveform operations do not load the Torch inference stack.

## Features

- Library discovery supports both legacy CLI output and manifest-backed generations.
- Generate from local audio or YouTube, with optional YouTube Music upload.
- Playback uses WaveSurfer multitrack media elements for a shared clock, with custom aligned waveform canvases, zoom, scrolling, seeking, mute, volume, and transport shortcuts.
- Settings persist the output folder, model preset, keyboard bindings, and OS-keychain YouTube Music credentials.
- Only the selected library folder is allowed through Tauri's asset protocol; the dialog scope is persisted between launches.

The cross-platform packaging workflow is `.github/workflows/desktop-release.yml`. macOS packages are wrapped as a `.pkg` which installs a `/usr/local/bin/makeitdrumless` symlink. Windows NSIS installs the app folder on the current user's PATH; Debian packages install the CLI sidecar in `/usr/bin`.
