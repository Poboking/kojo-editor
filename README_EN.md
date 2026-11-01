<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

[简体中文](README.md) | **English** | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

A structure-aware editor for **Kojo scripts** of era-series games (eraTW and friends).  
Tauri 2 shell (Rust does IO primitives only) + React 19 + Monaco, pnpm monorepo.  
**The kernel knows nothing about any game. Everything is a plugin.**

</div>

---

> **This README is written for developers** — how the repo is laid out, what it takes to run it,
> how to prove a change, and how to add a plugin.
>
> - Just want to **use the editor**? Grab it from [Releases](https://github.com/Poboking/kojo-editor/releases/latest); the manual is [docs/USER-GUIDE.md](docs/USER-GUIDE.md) (Chinese).
> - Want to **see it first**? [main window](docs/assets/app-editor.jpg), [condition matrix](docs/assets/app-condition-matrix.jpg), [market](docs/assets/app-market.jpg).
> - Read before you touch anything: [AGENTS.md](AGENTS.md) — the single entry point for rules, commands and collaboration discipline (Chinese).

## 1. What this is (engineering view)

A desktop application that turns a Kojo library of 2,000+ `.ERB` files and ~10⁵ functions into something you can navigate, validate, replay and rewrite.

| Aspect | Fact |
|---|---|
| Form factor | Tauri 2 desktop shell + Monaco as the editor body; Windows 10/11 x64 |
| Kernel | DI, event bus, scoped storage, file IO, projects, slots, workspaces, compute pool — **zero game vocabulary** (enforced by audit) |
| Extensibility | **31 plugins**: 8 game adapters + language layer + UI panels + market / savefile / sugar |
| Scale | Functional pool: **1,163 files · 22,158 passed / 0 failed** (plus 143 skipped depending on corpus presence) |
| Gates | Dual typecheck · decoupling audit (A–D) · language-ratchet audit · boot-graph size gate · one-command release gate |

## 2. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│ Plugin layer (31, everything is a plugin)                    │
│  game adapters × 8 │ language (ERB / kojo 1.0 / 2.0) │ UI    │
│  market · savefile parser · state replay · sugar · linter …  │
├──────────────────────────────────────────────────────────────┤
│ Slot registry (UI and extension points; many per slot,       │
│ conflicts must be reported as errors)                        │
├──────────────────────────────────────────────────────────────┤
│ Kernel (generic facilities, zero game knowledge)             │
│ DI │ bus │ storage │ file IO │ project │ slots │ workspace │ pool │
├──────────────────────────────────────────────────────────────┤
│ Tauri 2 Rust host: IO primitives / windows / launcher only   │
└──────────────────────────────────────────────────────────────┘
```

Four rules to keep in mind (checked by `pnpm audit:decoupling`; see [AGENTS.md](AGENTS.md) §2):

1. **Kernel / contracts / Rust host contain no game names** — game knowledge lives only in adapter plugins;
2. **Plugins may depend on `@kojo/plugin-api` only** — no importing the kernel, no plugin-to-plugin imports;
3. **Writes go through three non-inheriting authorization channels**: kernel `writablePaths`, `exportFile` (the dialog *is* the grant), launcher `launcher/approvals.json`;
4. **The kernel never fails silently** — inactive must be visible, conflicts must be errors, rule exceptions must land in `report.failedRules`.

Design rationale (layering, slot definitions, full ADR set): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/adr/](docs/adr/) (Chinese).

## 3. Repository layout

```
packages/
├── kernel/            DI / bus / storage / file IO / slot registry / compute pool (zero game knowledge)
├── plugin-api/        the only public contract package: plugin types, service keys, adapter interfaces
├── app/               desktop shell: Tauri (Rust host) + React + Monaco + platform bridge + composition root
│   └── src-tauri/     Rust IO primitives, windows, launcher (cargo test --lib is its own gate)
├── kojo-core/         Kojo 2.0 core: lexer / grammar / AST / lowering / diagnostics / source maps
├── kojo-lang/         Kojo language-surface predicates and Monaco data
├── kojo-sdk/          SDK for language-pack authors: 2.0 contract shapes + structure worker protocol
├── kojo-vocab/        Vocabularies shared by ERB / kojo1 / kojo2 (not a plugin)
├── kojo-syntax-tree/  tree-sitter CST and queries for .kojo
├── erb-lang/          ERB language-surface predicates (highlight / expand / signature help)
├── erb-vocab/         ERB engine vocabulary: control-flow pairing table, per-word classification
├── erb-syntax-tree/   tree-sitter CST and fold queries for line-oriented ERB
├── kojo-conformance/  Adapter conformance kit: contract self-check, DSL→ERB goldens, differential, encoding/EOL
├── kojo-project-kit/  Shared Kojo-project workflow (create / import / deploy / publish wizard)
└── plugins/           31 plugins, grouped below
```

`packages/plugins/` in four families:

| Family | Directories |
|---|---|
| Game adapters (8) | `eratw-` `erafl-` `erakoumakan-` `erasqc-` `eratohok-` `eratohoreverse-` `eraav-` `eraakumamaid-adapter` |
| Language surface | `erb-parser` `erb-lang` `kojo-lang` `kojo-sugar` `inline-completion-local` |
| Domain capability | `condition-extractor` `convention-linter` `sav-parser` `state-replay` `kojo-market` `launcher-core` |
| UI panels (12) | `ui-kojo-navigator` `ui-kojo-xml` `ui-condition-matrix` `ui-convention-report` `ui-sugar-editor` `ui-sugar-lift` `ui-sugar-preview` `ui-state-replay` `ui-snapshot-injector` `ui-archive-browser` `ui-market` `ui-plugin-status` |

Also: `docs/` (architecture, state, board, pitfalls, ADRs), `tools/` (audits, release gate, debug host, measuring rigs, smoke tests), `fixtures/` (sanitized Kojo samples and sugar fixtures), `skills/kojo-debug/` (debug-mode skill).

## 4. Environment and first run

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 22 | same as CI and release |
| pnpm | 11.22.0 | pinned by `packageManager`; install via `corepack enable` |
| Rust | stable ≥ 1.77 | desktop shell only; MSVC toolchain |
| WebView2 | system | preinstalled on Windows 11, runtime needed on Windows 10 |

```bash
corepack enable
pnpm install

pnpm dev                            # frontend only (vite, runs in a browser, no shell)
pnpm --filter @kojo/app tauri dev                      # desktop shell (first cargo build ~20–30 min)
pnpm --filter @kojo/app build       # frontend bundle
pnpm --filter @kojo/app tauri build # installer (NSIS + updater artifacts)
```

No desktop session? `node tools/debug-cli.mjs serve` boots "debug host + vite + browser (CDP)" and prints the editor URL.

## 5. Verification matrix

**Definition of done: every "it works" comes with numbers** — test counts must not regress, both typechecks must be clean, audits must be green.

```bash
pnpm test                    # both pools (functional + timing; don't set KOJO_SMOKE_PROJECT here)
pnpm test:unit               # functional pool only (parallel)
pnpm test:perf               # timing pool only (serial, quiet — never mixed with the functional pool)

pnpm typecheck                       # root
pnpm --filter @kojo/app typecheck    # app (both count)

pnpm audit:decoupling        # "everything is a plugin" audit: A–D plus the 31-plugin count
pnpm audit:language          # language ratchet: M1 game names / M2 language-id branches / M3 legacy tokens
pnpm audit:bytes             # raw-byte health check: NUL / BOM / invalid UTF-8 / stray CR
pnpm audit:board             # board structure and reference self-check
```

The release gate folds the machine-checkable surface into one command with per-item readings and a single `RESULT: PASS|FAIL`:

```bash
node tools/release-gate.mjs --skip-tests        # CI fast profile: dual typecheck + audits + conformance
node tools/release-gate.mjs --release --json    # release profile: adds version-sync / both pools / artifact-audit / cargo
```

Rust side (only when `src-tauri` changed — **must be launched through node**, Git-Bash `TMP` breaks MSVC linking with LNK1104):

```bash
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
```

Real corpus / desktop-shell smoke (the corpus directory name changes and may be absent — probe first):

```bash
node tools/corpus.mjs --print        # continue only on rc=0; otherwise skip the corpus-backed tier
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts

node tools/smoke-tauri-dom.mjs       # DOM smoke
node tools/smoke-tauri-ipc.mjs       # real IPC, both gates (restores store / files / backups)
node tools/debug-web-smoke.mjs       # headless end-to-end
```

Current baseline numbers (test counts, size gates, memory and perf readings) live in **[docs/STATE.md](docs/STATE.md)** only — do not trust memory or older docs.

## 6. Writing plugins and adapters

**The dependency direction is a hard constraint**: `plugin → @kojo/plugin-api ← kernel`. Plugins never import each other; they collaborate through service keys and slots.

- **New plugin**: `packages/plugins/<name>/` + `package.json` (`@kojo/plugin-<name>`) + an exported `Plugin` descriptor (`requires` / contributions). UI goes through the `ui.panel` slot; language services declare via `services.slot`.
- **New game**: never touch the kernel — add an adapter plugin. One command scaffolds the package, the manifest entry, the dependency and the path aliases (the four scattered points are edited by the tool; `adapter-manifest.test.ts` proves both directions):

  ```bash
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
  ```

  Authoring guide: [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md); conformance kit: `@kojo/kojo-conformance`.
- **Three language layers**: ERB (native engine), kojo 1.0 (legacy surface), kojo 2.0 (current channel). Predicates live in library packages (pure functions, zero Monaco / React / IO); the host only assembles and translates. New language capability goes into a library package plus a slot provider — not as host branches (`audit:language` counts M2).

## 7. Debugging and evidence gathering

The primary verification channel for parallel agent work is debug mode (UI / commands / events / semantic readings without a desktop shell):

```bash
node tools/debug-cli.mjs serve        # debug host + vite + browser (CDP), prints the editor URL
node tools/debug-cli.mjs shell        # real desktop shell + CDP (startup phases, frameless, geometry)
node tools/debug-cli.mjs <command>    # open-project / open-file / commands/run / state / dom / events
                                      # eval / invoke / click / type / key / screenshot / status / stop
```

The manual and extension rules live in [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) (read §5 before extending).

## 8. Documentation map

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | **first entry point for any agent**: rules, commands, git and collaboration discipline |
| [docs/STATE.md](docs/STATE.md) | single source of truth for baseline numbers |
| [docs/BOARD.md](docs/BOARD.md) | in-flight board: read before claiming, delete the row on delivery |
| [docs/PITFALLS.md](docs/PITFALLS.md) | hard-won traps (writes, probes, multi-agent, builds) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layering, slots, core interfaces, technical decisions |
| [docs/adr/](docs/adr/) | architecture decision records |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | debug-mode manual and extension rules |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | onboarding a new dialect / game |
| [docs/SYNTAX-SUGAR-SURFACE-SPEC.md](docs/SYNTAX-SUGAR-SURFACE-SPEC.md) | full `.kojo` surface syntax spec |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **manual for authors** (no internals) |

## 9. Contributing

Branch model (since 2026-10-19; `master` is gone, remote default is `main`):

- `dev` — daily landing branch for features, fixes and doc batches;
- `main` — release branch, updated **only when releasing** (merge vetted dev commits → tag `v*`);
- one agent per worktree; one short-lived branch per batch `b/<agent>/<MMDD>-<slug>`, cut from `origin/dev`, **never commit directly on local `dev` / `main`**.

Landing means passing the narrow gate:

```bash
git fetch origin --prune
git rebase origin/dev
# all gates green (see §5)
git push origin HEAD:dev
```

A rejected non-fast-forward *is* the concurrency protocol — re-run fetch + rebase and push again; **never** force-push `dev` / `main`. Commit messages use Conventional Commits with Chinese subject lines; no `git add -A` (add file by file), no `stash` in shared worktrees.

Doc discipline: write exactly two things — the claim (one line in `docs/BOARD.md`) and the delivery (readings and trade-offs in the commit message). Hard traps go into `PITFALLS.md` one line each; `STATE.md` changes only when the baseline actually moves.

## 10. Releasing

```bash
# 1. the three version fields must be byte-identical (pinned by app-version.test.ts)
#    package.json / packages/app/package.json / packages/app/src-tauri/tauri.conf.json
# 2. machine surface fully green
node tools/release-gate.mjs --release --json
# 3. merge vetted dev commits into main and tag (release.yml is tag-triggered)
git checkout main && git merge --ff-only <vetted-commit> && git tag v0.4.2
git push origin main --tags
```

`release.yml` produces the NSIS installer, a portable zip, updater artifacts (`latest.json` + signed bundle) and `SHA256SUMS.txt`. It first runs the fast gate itself (`--only=version-sync,typecheck-root,typecheck-app,audit,conformance`) and refuses to build on a non-zero exit.

## 11. License and credits

[GPL-3.0-or-later](LICENSE). The repository ships no game content — screenshots and test inputs come from games installed locally; `fixtures/` holds sanitized structural samples only.

Thanks to eraTW and the whole era community for years of creation.

Maintainer: [**Poboking**](https://github.com/Poboking)
