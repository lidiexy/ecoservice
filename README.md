# ecoservices

A lightweight macOS alternative to [DBngin](https://dbngin.com): spin up local **PostgreSQL, Redis, MongoDB and RabbitMQ** in one click. Built with **Tauri v2** (Rust) and a vanilla TypeScript UI styled with **Basecoat** (shadcn-style components for plain HTML, on Tailwind v4). Services run as Docker containers on **Colima**, so no Docker Desktop is required.

## Features

- **Quick Start cards**: launch a service on its default port with one click. If the default port is taken, the next free port is used and flagged with a yellow `5432 busy → 5433` badge.
- **Add Custom Service drawer**: service type (searchable combobox), port with live availability check (green/red border and suggested free port), optional custom name, custom Docker image/tag, and a **Persist data** toggle (volume vs. ephemeral).
- **Running Services list** with status, uptime, image tag, and live **CPU / memory** usage.
- **Per-service actions**: stop/start, restart, delete container (data kept), **live logs** drawer, and **copy connection string**.
- **Image download progress**: first launch shows `Downloading postgres image: 3/7 layers`.
- **Auto-discovery**: any container named `dbngin-clone-*` is picked up, including ones created outside the app.

## Requirements

| Tool | Install | Notes |
|------|---------|-------|
| macOS | — | Tested on macOS 26, Intel. Apple Silicon should work. |
| Colima + Docker CLI | `brew install colima docker` | Colima provides the Docker engine. |
| Rust (stable) | [rustup.rs](https://rustup.rs) | With zsh, put `. "$HOME/.cargo/env"` in `~/.zshenv`. |
| Node.js 20+ | `brew install node` | For Vite and the Tauri CLI. |
| Xcode Command Line Tools | `xcode-select --install` | Required by Tauri on macOS. |

## Getting started

```bash
colima start            # start the Docker engine (the app also tries this on launch)
npm install
npm run tauri dev       # run the app with hot reload
```

## Building for macOS

```bash
npm run build:mac
```

This produces:

- `src-tauri/target/release/bundle/macos/ecoservices.app`
- `src-tauri/target/release/bundle/dmg/ecoservices_<version>_<arch>.dmg`

`build:mac` builds the `.app` with Tauri, then packages the `.dmg` with `scripts/make-dmg.sh`. Tauri's own `.dmg` step (`npm run tauri build`) fails with `hdiutil: create failed - Resource busy` on machines running antivirus that scans mounted volumes (e.g. Sophos). On a clean machine or CI, `npm run tauri build` works too.

**Unsigned app:** macOS Gatekeeper will warn on first launch. Right-click the app → **Open**, or run `xattr -cr /Applications/ecoservices.app`. Distributing to others requires an Apple Developer ID for signing and notarization.

## Services

| Service | Default port | Default image | Connection string | Data mount |
|---------|--------------|---------------|-------------------|------------|
| PostgreSQL | 5432 | `postgres:latest` | `postgresql://postgres:postgres@localhost:5432/postgres` | `/var/lib/postgresql` (18+), `/var/lib/postgresql/data` (<18) |
| Redis | 6379 | `redis:latest` | `redis://localhost:6379` | `/data` |
| MongoDB | 27017 | `mongo:latest` | `mongodb://localhost:27017` | `/data/db` |
| RabbitMQ | 5672 | `rabbitmq:management` | `amqp://guest:guest@localhost:5672` | `/var/lib/rabbitmq` |

- **PostgreSQL** password is `postgres`.
- **RabbitMQ management UI** is exposed on **port + 10000** (5672 → http://localhost:15672, login `guest`/`guest`) when the image tag contains `management`.
- **Persisted data** lives in `~/Library/Application Support/com.ecoservices.app/<type>-<port>/`. Deleting a container keeps this folder. Delete the folder to reset the data.
- **Ephemeral** services run with `--rm` and are destroyed when stopped.

## How it works

The Rust backend shells out to the `docker` and `colima` CLIs via `tauri-plugin-shell`. All commands run from Rust, so no shell permissions are exposed to the webview.

- Containers are named `dbngin-clone-<type>-<port>`. An optional display name is stored in the Docker label `ecoservices.name`.
- The UI polls every 5 seconds (`docker ps -a`, then `docker stats --no-stream`). Logs poll every 2 seconds while the logs drawer is open.
- Port checks try a TCP connect to `127.0.0.1:<port>` and also compare against existing containers.
- Container actions (`start`, `stop`, `restart`, `rm`) are whitelisted and only accepted for `dbngin-clone-*` containers. Image names and custom names are validated before being passed to Docker.
- At startup the app prepends `/opt/homebrew/bin:/usr/local/bin` to `PATH`, because apps launched from Finder don't inherit your shell's `PATH`.

### Tauri commands

| Command | Purpose |
|---------|---------|
| `initialize_backend` | Starts Colima (2 CPU / 2 GB) if it isn't running |
| `start_service` | Pulls the image (emitting `pull-progress` events) and runs the container |
| `list_services` | Lists `dbngin-clone-*` containers with status, image and label |
| `service_stats` | CPU % and memory usage per running container |
| `container_action` | start / stop / restart / rm |
| `container_logs` | Last 300 lines of merged stdout/stderr |
| `port_in_use` | Whether something on the host already listens on a port |

## Project structure

```
├── index.html              # App shell: topbar, cards, services list, drawers
├── src/
│   ├── main.ts             # UI logic: rendering, polling, port checks, drawers
│   ├── services.ts         # Types, service templates, invoke() wrappers
│   ├── styles.css          # Tailwind + Basecoat imports and theme overrides
│   └── assets/             # Service logos (Simple Icons)
├── src-tauri/
│   ├── src/lib.rs          # Backend commands, parsers and unit tests
│   ├── tauri.conf.json     # Window, bundle and identifier config
│   └── capabilities/       # Tauri permissions (core:default only)
├── scripts/make-dmg.sh     # .dmg packager that avoids the hdiutil "Resource busy" issue
└── handoff.md              # Original design/handoff notes
```

## Development

```bash
npx tsc --noEmit                    # typecheck the frontend
npx vite build                      # build the frontend only
cd src-tauri && cargo test          # backend unit tests (parsers, validation, mounts)
```

UI components come from [Basecoat](https://basecoatui.com): `.btn`, `.card`, `.badge`, `.field`, `.combobox` and `.drawer`. Interactive components are initialised by importing `basecoat-css/<component>` in `main.ts`. The theme lives in the `.dark` token overrides at the top of `src/styles.css`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `failed to run 'cargo metadata'` | Cargo isn't on `PATH`. Run `source ~/.zshenv` or open a new terminal. |
| `Cannot connect to the Docker daemon` | Run `colima start`. Check with `colima status` and `docker context ls` (the context should be `colima`). |
| Port shows as taken but nothing is running | Another process is listening on it. Find it with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. |
| Built app shows no containers | Make sure `docker` is installed in `/usr/local/bin` or `/opt/homebrew/bin`. |
| `.dmg` step fails with `Resource busy` | Use `npm run build:mac`. |
| Remove a downloaded image | `docker rmi <image>`, e.g. `docker rmi postgres` (from any terminal). |

## Roadmap

- Windows/Linux support (skip Colima, use Docker Desktop or WSL2; platform-specific `PATH` handling)
- CI builds with `tauri-action`
- Check for Colima/Docker on first run and offer to install them
- Custom passwords and environment variables
- Stream logs (`docker logs -f`) and stats (`docker events`) instead of polling
- Code signing and notarization
