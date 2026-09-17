# Mangalapuram Township Planner — Claude Code handover package

## How to use
1. Unzip this folder somewhere (e.g. `~/projects/mangalapuram-planner`).
2. Open a terminal in the folder and run `git init && git add . && git commit -m "handover package"` (optional but recommended).
3. Start Claude Code in the folder: `claude`
4. Type: **start building**

Claude Code reads `CLAUDE.md` automatically and builds the web app in `app/`, milestone by milestone, testing against the golden values.

Requirements on your machine: Node.js 20+, npm, git. Python 3.11+ only if you want to re-run preprocessing (not needed to build).

## Run the app (once built)
```bash
cd app && npm install && npm run dev
```

## What's inside
See `CLAUDE.md` → Repository map. Key files: `docs/SPEC.md`, `config/*.yaml`, `data/processed/`.

## Updating inputs later
- New survey / Google Earth levels / deferred-land boundary: add files to `data/raw/`, re-run `tools/preprocess` (see its README), then tell Claude Code "reload site data".
- Client rule changes: edit `config/client_rules.yaml` (or in the app) and log the change in `docs/DECISIONS.md`.
