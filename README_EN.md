<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

**简体中文** | [English](README_EN.md) | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**A structure-aware IDE for era-series script sources (`.ERB` / `.kojo`).**
Tauri 2 shell (Rust does IO primitives only) + React 19 + Monaco, pnpm monorepo.
**Zero game knowledge in the kernel; everything is a plugin.**

</div>

| Go to definition `F12` (cross-file) | Find references `Shift+F12` (peek, counted per file) |
|---|---|
| ![Go to definition](docs/assets/erb-definition.gif) | ![Find references](docs/assets/erb-references.gif) |
| Completion (as you type, filtered by name slot) | Search across the project (10 hits · 4 files) |
| ![Completion](docs/assets/erb-completion.gif) | ![Search across the project](docs/assets/editor-search.gif) |
| Command palette (100+ rebinding-able commands) | Folding (ranges from the tree-sitter CST) |
| ![Command palette](docs/assets/editor-palette.gif) | ![Folding](docs/assets/editor-folding.gif) |

> Demo data is entirely synthetic (`tools/gif-scenarios/demo-project/`); replay command in §10.

---

- Download and use: [Releases](https://github.com/Poboking/kojo-editor/releases/latest) · author's manual: [docs/USER-GUIDE.md](docs/USER-GUIDE.md)
- Read before contributing: [AGENTS.md](AGENTS.md) (invariants, commands, collaboration discipline)

## 1. Why "one more syntax highlighter" is not the problem

ERB is a line-oriented scripting language from 1998: no LSP, no AST toolchain, no package manager. A real project holds **3,971 dialect files / 110,049 function definitions** (measured; see [docs/STATE.md](docs/STATE.md)), and kojo functions call each other **by naming convention** (`M_KOJO_{chara}_MESSAGE_COM_{command}`) — rename one thing and the call sites are scattered across the whole project.

What is needed is a full IDE surface: **index → symbols → references → diagnostics → rewrite**. This project builds it as three auditable layers: decisions live in library packages (pure functions, no Monaco, no IO), the host only assembles and translates, and game knowledge may only enter adapter plugins (enforced both by `pnpm audit:decoupling` and `pnpm audit:language`).

## 2. ERB language support

> Keys below are defaults; every one of them can be rebound in the in-app keybindings page. The last column points at the **code**.

| Capability | Default key | Where the logic lives |
|---|---|---|
| Go to definition (cross-file) | `F12` | `packages/app/src/monaco/kojo-definition.ts` ← index providers |
| Peek definition (expand in place) | `Alt+F12` | Monaco built-in on the same providers |
| Go to implementation | `Ctrl+F12` | same |
| Find references (peek + per-file counts) | `Shift+F12` | `packages/app/src/monaco/find-references.ts` |
| Hover docs (author comments + parameter list + definition site) | `Ctrl+K Ctrl+I` | `packages/app/src/monaco/kojo-hover.ts` |
| Signature help (active parameter) | `Ctrl+Shift+Space` | `packages/app/src/monaco/kojo-signature.ts` |
| Completion (trigger chars `#` `[` `@` `$` `.`) | `Ctrl+Space` / as you type | `packages/app/src/monaco/erb-completion*.ts` |
| Live validation (squiggles + problems panel + status bar counts) | `Ctrl+Shift+M` panel · `Alt+F8` per item | `packages/plugins/convention-linter` → `packages/app/src/monaco/slot-service-providers.ts` |
| Rename symbol (all files at once) | `F2` | Monaco built-in on the language-side rename provider |
| Document symbols / go to symbol in file | `Ctrl+Shift+O` | `packages/app/src/monaco/kojo-symbols.ts` |
| Occurrence highlight · smart select · code lens | `Ctrl+D` / `Shift+Alt+→` / inline | `erb-highlight.ts` · `erb-selection-range.ts` · `kojo-code-lens.ts` |
| Folding (per function body / block) | folding gutter | `kojo-folding.ts` + `erb-syntax-tree` (tree-sitter CST) |

Go to definition resolves against the **cross-file** function index, not text matching inside the current file. Find references returns a peek widget with hits grouped and counted per file. Completion candidates are filtered by **name slot** — dialogue, narration, comments and string segments do not pop.

## 3. Editor capabilities

- **Every capability has a programmatic entry point**: 100+ commands in the palette (`Ctrl+Shift+P`), all rebinding-able, and the debug CLI drives the UI through the same path (§10).
- **Editor groups**: split right / down (`Ctrl+\`), row/column arrangement, `Ctrl+1..4` focus, enlarge/shrink the focused group.
- **Multi-cursor and column editing**: `Ctrl+D` add next, `Ctrl+Shift+L` add all, `Ctrl+Alt+↑/↓` column cursors, `Alt+↑/↓` move lines, `Ctrl+Shift+K` delete line.
- **Encoding and EOL are preserved**: files are read with their declared encoding (Shift-JIS / GBK / UTF-8) and written back **byte-for-byte** in the original EOL/BOM shape — editing one line does not reformat the file.
- **Read-only protection**: files in a game directory are read-only; the first real keystroke asks. The unlock applies to **this file, this session** — after a restart protection is back.
- **Three non-inheritable write authorization channels**: kernel `writablePaths`, `exportFile` (the system dialog *is* the authorization), and launcher `launcher/approvals.json`.

Author-facing product panels (state injector / kojo market / archive browser / sugar editor / condition matrix / deploy wizard) are plugins; see [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

## 4. How it is built

| Surface | Approach |
|---|---|
| Language layers | **ERB** (engine native) / **kojo 1.0** (legacy surface) / **kojo 2.0** (current channel) coexist behind the same slot providers. Adding a language = adding one descriptor, not adding `if (languageId === …)` branches to the host (`audit:language` counts M2 for exactly that) |
| Structure & folding | one tree-sitter CST each (`packages/erb-syntax-tree`, `packages/kojo-syntax-tree`); folding and the structure view read the CST — no counting `IF/ENDIF` with regex |
| Index | project-level indexing walks the **whole ERB subtree** (kojo root + read-only base libraries folded into one scan root) and produces the name registry, reference flow, parameters and `#DIM` declarations. Snapshots are persisted; a warm load reads them (measured on real data: `read+parse 0ms`, `refs scan 2ms`) |
| Diagnostics | the `convention-linter` plugin owns the rules; messages are translated into plain language stating the **engine consequence**; a rule that throws must land in `report.failedRules` (the kernel never stays silent) |
| Performance | compute runs in a dedicated worker pool (the structure layer was merged into a single pool); cold-start and memory readings are booked per batch in [docs/STATE.md](docs/STATE.md) |
| Scale | functional pool **1,170 files · 22,281 passed / 0 failed** (~143 skipped depending on corpus presence) · timing pool 31 files · dual typecheck · four audits · 31 plugins |

Baseline numbers (test counts / size gates / memory / cold start / corpus) live in [docs/STATE.md](docs/STATE.md).

## 5. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│ Plugin layer (31 plugins — everything is a plugin)           │
│  game adapter × 8 │ language surfaces (ERB / kojo 1.0 / 2.0)  │
│  market · archive parsing · state replay · sugar · linting … │
├──────────────────────────────────────────────────────────────┤
│ Slot registry (UI + extension points; multiple registrations  │
│ per slot are allowed, conflicts must be reported as errors)  │
├──────────────────────────────────────────────────────────────┤
│ Kernel (generic facilities, zero game knowledge)             │
│ DI │ event bus │ storage domains │ file IO │ project │ slots  │
├──────────────────────────────────────────────────────────────┤
│ Tauri 2 Rust host: IO primitives / windows / launcher only    │
└──────────────────────────────────────────────────────────────┘
```

Four invariants to recite before changing anything (`pnpm audit:decoupling` checks them; details in [AGENTS.md](AGENTS.md) §2):

1. **Zero game nouns in kernel / contracts / Rust host** — game knowledge lives only in adapter plugins;
2. **Plugins may depend only on `@kojo/plugin-api`** — no kernel imports, no cross-plugin imports;
3. **Three non-inheritable write authorization channels** (last bullet of §3);
4. **The kernel never stays silent** — inactive must be visible, conflicts must error, validation failures must land in `report.failedRules`.

Full design rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/adr/](docs/adr/).

## 6. Repository layout

```
packages/
├── kernel/            DI / bus / storage domains / file IO / slot registry / compute pool (zero game knowledge)
├── plugin-api/        the single public contract package: plugin types, service keys, language & adapter interfaces
├── app/               desktop shell: Tauri (Rust host) + React + Monaco + platform bridge + composition root
│   ├── src/monaco/    language assembly layer (definition / references / hover / signature / completion / symbols / folding)
│   └── src-tauri/     Rust IO primitives, windows, launcher (its own `cargo test --lib` gate)
├── kojo-core/         Kojo 2.0 language core: lexer / grammar / AST / desugar / diagnostics / source map
├── kojo-lang/         Kojo language decisions + Monaco data (symbol tree, declaration index, indent & Enter …)
├── erb-lang/          ERB language decisions (occurrence highlight, smart select, signature help)
├── erb-vocab/         ERB engine vocabulary: control-flow pairing tables and per-word classification
├── erb-syntax-tree/   tree-sitter CST for ERB's line structure + folding queries
├── kojo-syntax-tree/  tree-sitter CST and queries for .kojo
├── kojo-sdk/          language-pack author SDK: 2.0 contract shape + structure worker protocol + role tables
├── kojo-vocab/        shared vocabulary and pure functions for ERB / kojo1 / kojo2 (not a plugin)
├── kojo-conformance/  adapter conformance suite: contract self-check, DSL→ERB golden, diffing, encoding/EOL preservation
├── kojo-project-kit/  shared kojo project workflow implementation (new / import / deploy / publish wizards)
└── plugins/           31 plugins: 8 game adapters + language surfaces + domain capabilities + UI panels
```

`packages/plugins/` splits into four families:

| Family | Directories |
|---|---|
| Game adapters (8) | `eratw-` `erafl-` `erakoumakan-` `erasqc-` `eratohok-` `eratohoreverse-` `eraav-` `eraakumamaid-adapter` |
| Language surfaces | `erb-parser` `erb-lang` `kojo-lang` `kojo-sugar` `inline-completion-local` |
| Domain capabilities | `condition-extractor` `convention-linter` `sav-parser` `state-replay` `kojo-market` `launcher-core` |
| UI panels (12) | `ui-kojo-navigator` `ui-kojo-xml` `ui-condition-matrix` `ui-convention-report` `ui-sugar-*` `ui-state-replay` `ui-snapshot-injector` `ui-archive-browser` `ui-market` `ui-plugin-status` |

Supporting directories: `docs/` (architecture, state, board, pitfalls, ADRs), `tools/` (audits, release gate, debug, meters, smoke scripts, GIF recorder), `fixtures/` (sanitized kojo samples), `skills/kojo-debug/` (debug-mode onboarding skill).

## 7. Environment and first run

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 22 | same version as CI and release |
| pnpm | 11.22.0 | pinned by `packageManager`; install with `corepack enable` |
| Rust | stable ≥ 1.77 | desktop shell only; MSVC toolchain |
| WebView2 | provided by the OS | preinstalled on Windows 11, runtime needed on Win10 |

```bash
corepack enable
pnpm install

pnpm dev                            # frontend only (vite, runs in a browser, no shell)
pnpm --filter @kojo/app tauri dev   # shell development (first cargo build takes 20–30 min)
pnpm --filter @kojo/app build       # frontend bundle
pnpm --filter @kojo/app tauri build # installers (NSIS + updater artifacts)
```

You can also work on the UI without a desktop session: `node tools/debug-cli.mjs serve` brings up "debug host + vite + browser (CDP)" and prints the editor URL.

## 8. Verification matrix

**Acceptance rule: every "it's fixed" must come with numbers** — test count must not regress, both typechecks must be clean, audits must be green.

```bash
pnpm test                    # both pools (functional + timing; do not set KOJO_SMOKE_PROJECT for a full run)
pnpm test:unit               # functional pool only (parallel)
pnpm test:perf               # timing pool only (serial, quiet pool — never mix with the functional pool)

pnpm typecheck                       # root
pnpm --filter @kojo/app typecheck    # app (both count)

pnpm audit:decoupling        # "everything is a plugin" decoupling audit: checks A–D + 31 plugin count
pnpm audit:language          # language-surface ratchet: M1 game nouns / M2 language-id branches / M3 legacy tokens
pnpm audit:bytes             # raw byte check: NUL / BOM / invalid UTF-8 / lone CR
pnpm audit:board             # board structure and reference self-check
```

The release gate collapses the machine surface into one command, reporting each reading and a final `RESULT: PASS|FAIL`:

```bash
node tools/release-gate.mjs --skip-tests        # CI fast lane: dual typecheck + audits + conformance
node tools/release-gate.mjs --release --json    # release lane: adds version-sync / both pools / artifact-audit / cargo
```

Rust side (only when `src-tauri` changed, and it **must** be started through node — Git-Bash's `TMP` makes MSVC linking fail with LNK1104):

```bash
node -e "require('child_process').execSync('cargo test --lib',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
```

Real corpus / desktop shell smoke (the corpus directory name changes and it may leave the machine entirely — probe before you run):

```bash
node tools/corpus.mjs --print        # rc=0 or skip the corpus lane
KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" \
  node node_modules/vitest/vitest.mjs run packages/kernel/tests/integration-plugins.test.ts

node tools/smoke-tauri-dom.mjs       # DOM smoke
node tools/smoke-tauri-ipc.mjs       # real IPC gates (restores store / files / backups)
node tools/debug-web-smoke.mjs       # headless browser end to end
```

## 9. Writing plugins and adapters

**The dependency direction is a hard constraint**: `plugin → @kojo/plugin-api ← kernel`. Plugins never import each other; they collaborate through service keys and slots.

- **Add a plugin**: `packages/plugins/<name>/` + `package.json` (named `@kojo/plugin-<name>`) + a `Plugin` descriptor (`requires` / contributions). UI goes through the `ui.panel` slot, language services through `services.slot` declarations.
- **Add a game**: never touch the kernel — add an adapter plugin. One command generates the skeleton, manifest entry, dependency and path alias (four scattered points updated by the tool; `adapter-manifest.test.ts` proves both directions):

  ```bash
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2 --dry-run
  node tools/new-dialect.mjs --id mygame --title "My Game" --ext kojo2
  ```

  Dialect authoring manual: [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md); conformance suite: `@kojo/kojo-conformance`.
- **Add a language capability**: the decision lives in a library package (pure function, no Monaco / no React / no IO); the host only assembles it into a provider in `packages/app/src/monaco/` and hands it out through a slot. Do not add language-id branches to the host (`audit:language` M2 counts them).

## 10. Debug mode and demo recording

The main verification channel for parallel agent work is debug mode (UI, commands, events and semantic readings can all be verified without a desktop shell):

```bash
node tools/debug-cli.mjs serve        # debug host + vite + browser (CDP), prints the editor URL
node tools/debug-cli.mjs shell        # real desktop shell + CDP (boot phases / frameless / window geometry)
node tools/debug-cli.mjs <subcommand> # open-project / open-file / commands/run / state / dom / events
                                      # eval / invoke / click / type / key / screenshot / status / stop
node tools/debug-cli.mjs definition 18 10   # semantic readings: definition / references / code actions /
                                            # signature / symbols / diagnostics
```

**The animations in this README were recorded through that channel** and can be replayed:

```bash
node tools/debug-cli.mjs serve --headless     # 1) start a session
node tools/readme-gif.mjs list                # 2) see the scenario list
node tools/readme-gif.mjs record all --max-kb 1500 --keyframes 3
```

Scenarios are declarative JSON steps under `tools/gif-scenarios/*.json` (real keystrokes, real mouse, command palette, semantic readings). Before each recording the demo project is reset to a known state; frames are sampled continuously over CDP and encoded with ffmpeg's two-pass palette, and the run reports frame count / duration / dimensions / bytes. `--keyframes` exports evenly spaced frames for image-by-image acceptance; `probe` runs the steps without sampling. Intermediates stay under `%TEMP%/kojo-gif/`, only the final `.gif` lands in the repository. Receipt read-backs are pinned by `tools/tests/readme-gif.test.ts`.

Single source of truth for the debug channel's manual and extension rules: [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) (read §5 before extending it).

## 11. Documentation map

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | **first entry point for every agent**: invariants, commands, collaboration and Git discipline |
| [docs/STATE.md](docs/STATE.md) | single source of truth for baseline numbers (tests / size / memory / performance / corpus) |
| [docs/BOARD.md](docs/BOARD.md) | active board: read before claiming, delete the row on delivery |
| [docs/PITFALLS.md](docs/PITFALLS.md) | hard-pitfall ledger (writes, probes, multi-agent, builds) — skim before you start |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layering, slots, core interfaces, technical decisions |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) | Kojo 2.0 language specification |
| [docs/adr/](docs/adr/) | architecture decision records (toolchain, host, authorization model, plugin source project …) |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | debug mode manual + extension rules |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | onboarding a new dialect / game |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **the author's manual** (no implementation detail) |

## 12. Contributing

Branch model (since 2026-10-19; `master` is deleted and the remote default branch is `main`):

- `dev` = the daily landing branch for features, fixes and documentation batches;
- `main` = the release branch, updated **only when shipping** (vetted dev commits merged in, then a `v*` tag);
- one agent per worktree; one short-lived branch per batch: `b/<agent>/<MMDD>-<slug>` created from `origin/dev`. **Never commit directly on local `dev` / `main`.**

Landing means passing the narrow gate:

```bash
git fetch origin --prune
git rebase origin/dev
# all gates green (see §8)
git push origin HEAD:dev
```

A rejected non-fast-forward *is* the concurrency protocol — fetch + rebase and push again; **never** force `dev` / `main`. Commit messages use Conventional Commits with a Chinese title. No `git add -A` (add file by file), no `stash` in a shared tree.

Documentation discipline: write exactly two things — a claim line in `docs/BOARD.md`, and the delivery receipt (readings and trade-offs) in the commit message. Hard pitfalls get one line each in `PITFALLS.md`; `STATE.md` changes only when the baseline actually moved.

## 13. Releasing

```bash
# 1. the three version fields must be byte-identical (pinned by app-version.test.ts)
#    package.json / packages/app/package.json / packages/app/src-tauri/tauri.conf.json
# 2. machine surface fully green
node tools/release-gate.mjs --release --json
# 3. merge vetted dev commits into main and tag (release.yml is tag-triggered)
git checkout main && git merge --ff-only <vetted commit> && git tag v0.4.2
git push origin main --tags
```

`release.yml` produces: the NSIS installer, the green `portable.zip`, updater artifacts (`latest.json` + signed packages) and `SHA256SUMS.txt`. Before building it runs the fast gate itself (`--only=version-sync,typecheck-root,typecheck-app,audit,conformance`) and stops if rc≠0.

## 14. License and credits

[GPL-3.0-or-later](LICENSE). The repository ships no game content: the animations and test fixtures here are either **synthetic samples** (`fixtures/`, `tools/gif-scenarios/`) or come from game directories installed locally and authorized by the user.

Thanks to eraTW and the whole era community for years of authoring.

Author: [**Poboking**](https://github.com/Poboking)
