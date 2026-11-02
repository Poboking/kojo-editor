<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

[简体中文](README.md) | **English** | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Stack](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**A structure-aware IDE for era-series script sources (`.ERB` / `.kojo`).**  
Tauri 2 shell (Rust does IO primitives only) + React 19 + Monaco, pnpm monorepo.  
**Zero game knowledge in the kernel; everything is a plugin.** Windows 10 / 11 x64.

</div>

## Demo

All six animations were recorded from the real UI. The demo data is entirely synthetic (see *License and credits* below), and one command replays the recording.

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/erb-definition.gif" width="480" alt="Go to definition"><br><sub><b>Go to definition</b> <code>F12</code> — resolves against the cross-file function index, not text matching in the current file</sub></td>
    <td width="50%" align="center"><img src="docs/assets/erb-references.gif" width="480" alt="Find references"><br><sub><b>Find references</b> <code>Shift+F12</code> — peek widget with hits grouped and counted per file</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/erb-completion.gif" width="480" alt="Completion"><br><sub><b>Completion</b> — candidates come from name slots: nothing pops inside dialogue, narration, comments or string segments</sub></td>
    <td width="50%" align="center"><img src="docs/assets/editor-search.gif" width="480" alt="Project-wide search"><br><sub><b>Project-wide search</b> — shown: 10 hits across 4 files</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/editor-palette.gif" width="480" alt="Command palette"><br><sub><b>Command palette</b> <code>Ctrl+Shift+P</code> — 100+ commands, most of them rebinding-able</sub></td>
    <td width="50%" align="center"><img src="docs/assets/editor-folding.gif" width="480" alt="Folding"><br><sub><b>Folding</b> — ranges come from the tree-sitter CST, never from counting <code>IF/ENDIF</code> with a regex</sub></td>
  </tr>
</table>

Recording method and scenario files: [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) §8.

## Start with who you are

| You | Begin here |
|---|---|
| **You want to read and revise other people's scripts, without writing code** | Install → open your game directory following [docs/USER-GUIDE.md](docs/USER-GUIDE.md) §3 (you **may decline write access**; browsing, linting, navigation and replay all still work) → turn on `.kojo` preview to read `.ERB` as a readable surface syntax in place |
| **You know ERB and want to write in your own syntax, shipping to the game in one click** | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) §7 (create a script project) → §8 (language surface and the save flow, including §8.8 for what `.kojo` 2.0 can and cannot do yet) → §10 (export / deploy) |
| **You want to read the code, add a plugin, or onboard a new era game** | [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) (environment, verification matrix, language wiring, plugins and adapters, releasing) + [AGENTS.md](AGENTS.md) (invariants and collaboration discipline — read it before you touch anything) |

All three paths rest on the same rule: every jump, every squiggle comes from a pure function pinned by unit tests, never from "this looks like ERB".

## The problem it takes on

ERB is a line-oriented scripting language from 1998: no LSP, no AST toolchain, no package manager. A real project holds **3,971 dialect files / 110,049 function definitions** (measured on the eraTW 4.980 baseline; see [docs/STATE.md](docs/STATE.md)), and script functions call each other **by naming convention** (`M_KOJO_{chara}_MESSAGE_COM_{command}`) — change one character and the call sites are scattered across the whole project; mistype a name and the engine **fails silently**.

So the missing piece is not "one more syntax highlighter" but a full IDE surface: **index → symbols → references → diagnostics → rewrite**. This project builds it as three auditable layers — decisions live in library packages (pure functions, no Monaco, no IO), the host only assembles and translates, and game knowledge may only enter adapter plugins (guarded from both sides by `pnpm audit:decoupling` and `pnpm audit:language`).

## ERB language surface

> The keys below are defaults; most can be rebound in the in-app keybindings page (three built-ins are not rebindable yet: writing mode `Ctrl+K Z`, save `Ctrl+S`, find in selection `Ctrl+Alt+F`). For where the logic lives, see [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) §6.

| Capability | Default key |
|---|---|
| Go to definition (cross-file) · peek definition · go to implementation | `F12` · `Alt+F12` · `Ctrl+F12` |
| Find references (peek + per-file counts) | `Shift+F12` |
| Hover docs (author comments + parameter list + definition site) | `Ctrl+K Ctrl+I` |
| Signature help (active parameter) | `Ctrl+Shift+Space` |
| Completion (trigger chars `#` `[` `@` `$` `.`; as you type) | `Ctrl+Space` |
| Live validation (squiggles + problems panel + status bar counts) | `Ctrl+Shift+M` panel · `Alt+F8` per item |
| Rename symbol (all files at once) | `F2` |
| Document symbols / go to symbol in file | `Ctrl+Shift+O` |
| Occurrence highlight · smart select · code lens | `Ctrl+D` · `Shift+Alt+→` · inline |
| Folding (per function body / block) | folding gutter |

## Panels for script authors

These are plugins, not host code. Usage lives in [docs/USER-GUIDE.md](docs/USER-GUIDE.md) (currently Chinese only).

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-editor.jpg" width="480" alt="Main window"><br><sub><b>Main window</b> — script project tree and tutorial entries on the left, multi-tab editing of `.kojo` / `.ERB` / `.md` in the middle, writability badge and diagnostic counts in the status bar</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-condition-matrix.jpg" width="480" alt="Condition matrix"><br><sub><b>Condition matrix</b> — state keys × timing faces as one table; click a filled cell to jump to the script function behind it (floating window)</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-syntax-reference.jpg" width="480" alt="KOJO syntax tables"><br><sub><b>KOJO syntax tables (appendix)</b> — how to write it, what it compiles to, and the exact message when you get it wrong; 13 tables in the sidebar</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-market.jpg" width="480" alt="Script market"><br><sub><b>Script market</b> — pull the registry, browse and install script / dictionary packages (shown: CI's synthetic demo packages)</sub></td>
  </tr>
</table>

> These four screenshots were taken from the 2026-10-20 interface; panel placement shifts batch to batch, so trust the app over the picture. The animations are not affected — replaying them produces the current shape.

The exact panel inventory (including which ones are **sealed by default** and which only exist **in the kojo1 tier**) is in [docs/USER-GUIDE.md](docs/USER-GUIDE.md) §6.3 — we treat "can't find the panel" as a documentation defect, not a user problem.

## The fundamentals

- **Encoding and EOL are preserved byte-for-byte**: files are read with their declared encoding (Shift-JIS / GBK / UTF-8 / UTF-16) and written back in the original EOL/BOM shape — editing one line does not reformat the file.
- **Game directories are read-only by default**: the first real keystroke asks. The unlock applies to **this file, this session**; after a restart protection is back. Your own work lives in a persistent writable workspace and is never affected.
- **Three non-inheritable write authorization channels**: kernel `writablePaths`, `exportFile` (the system dialog *is* the authorization), launcher `launcher/approvals.json`.
- **Every capability has a programmatic entry point**: 100+ commands in the palette, all rebinding-able, and the debug CLI drives the UI through the same path — which is how the six animations above were recorded.
- **Editor groups and multi-cursor**: split (`Ctrl+\`), `Ctrl+1..4` focus, column editing, line move, `Ctrl+Shift+L` add all.

## How quality is held

One rule: **every "it's fixed" must come with numbers**.

- functional pool **1,184 files · 22,491 passed / 0 failed / 149 skipped** (as of 2026-11-02; the skipped count moves with corpus presence) · timing pool 31 files;
- dual typecheck (root + app) · four audits (decoupling A–D, language ratchet, raw bytes, board) · boot-graph size gate · a separate `cargo test --lib` gate on the Rust side;
- **31 plugins**, including adapters for **8** era-series games;
- real-corpus readings (warm load `read+parse 0ms` / `refs scan 2ms`, memory and cold-open profiles, folding parity checks) are booked batch by batch in [docs/STATE.md](docs/STATE.md) — that file is the single source of truth; the snapshot here will go stale.

## What it does not do yet (honest list)

We would rather put the unfinished parts here than have you discover them the hard way:

- **`.kojo` (Kojo 2.0) currently covers editing, coloring, diagnostics and preview only.** Saving to a compiled `.ERB`, and the transpile step in export/deploy, still key on the sealed `.kojo1` layer and native `.ERB` (the predicate is `resolveSugarTarget`). **Say the consequence out loud**: exporting or deploying a package that contains `.kojo` files carries them into the package verbatim — the engine cannot read them, and the export **will not fail**. If your script has to reach the game today, create it as `.ERB` or `.kojo1`.
- **Windows 10 / 11 x64 only**; no macOS or Linux build.
- **Installers are not code-signed**: expect a SmartScreen prompt ("Windows protected your PC") on first run. Each Release ships `SHA256SUMS.txt` so you can verify before allowing it. Signing exists only on the auto-update channel.
- **Pre-release versions (containing `-`) do not enter the stable update channel** — download them manually from the Release page.
- ERB squiggles **conservatively exclude** `CASE` / `PRINTDATA` conditions; that is a known blind spot. Lines `.kojo` preview does not cover yet (loops, `TRY`, `SIF` branches, data tables, assignments and calls) stay displayed verbatim instead of being hidden.
- **The function index is not incremental**: files created or changed outside the editor appear via file watching, but newly defined functions need "Reload project" to enter the index.

The full debt ledger is in [docs/STATE.md](docs/STATE.md) §4.

## Running it from source

```bash
corepack enable && pnpm install
pnpm dev                            # frontend only (vite, runs in a browser, no shell)
pnpm --filter @kojo/app tauri dev   # shell development (first cargo build takes 20–30 min)
pnpm test                           # both pools; likewise pnpm typecheck / pnpm audit:decoupling
```

Dependencies: Node.js 22 · pnpm 11.22.0 (pinned by `packageManager`) · Rust stable ≥ 1.77 (desktop shell only) · WebView2.
For the complete environment matrix, verification matrix, plugin and dialect onboarding, demo recording and release flow: **[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)**.

## Documentation map

| Document | Purpose |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | **the script author's manual** (how to use it, no implementation detail; Chinese only for now) |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | developer handbook: environment, verification matrix, language wiring, plugins and adapters, debug and recording, releasing |
| [AGENTS.md](AGENTS.md) | collaboration entry point: invariants, commands, Git and documentation discipline |
| [docs/STATE.md](docs/STATE.md) | single source of truth for baseline numbers (tests / size / memory / performance / corpus / debt) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/adr/](docs/adr/) | layering and slot design rationale, decision records |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) · [docs/SYNTAX-SUGAR-SURFACE-SPEC.md](docs/SYNTAX-SUGAR-SURFACE-SPEC.md) | Kojo 2.0 language spec · `.kojo1` surface syntax spec |
| [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md) | onboarding a new dialect / game in five steps |
| [docs/DEBUG-MODE.md](docs/DEBUG-MODE.md) | debug mode manual and extension rules |
| [docs/BOARD.md](docs/BOARD.md) · [docs/PITFALLS.md](docs/PITFALLS.md) | active board · hard-pitfall ledger |

Contributing is "one short-lived branch per batch, through the narrow gate into `dev`": branch model, gates and commit conventions live in [AGENTS.md](AGENTS.md) §4 — please read it, and [docs/PITFALLS.md](docs/PITFALLS.md), before you start.

## License and credits

[GPL-3.0-or-later](LICENSE). The repository ships no game content: every animation and screenshot in this README comes from **synthetic samples** under `tools/gif-scenarios/demo-project/` and `fixtures/`; real corpora used by tests are only ever accessed read-only, in directories installed locally and authorized by the user.

Thanks to eraTW and the whole era community for years of authoring — this tool only writes down, in a form machines can cross-check, the naming conventions the community has passed on by word of mouth.

Maintainer: [**Poboking**](https://github.com/Poboking) · ideas and bug reports welcome in [Issues](https://github.com/Poboking/kojo-editor/issues)
