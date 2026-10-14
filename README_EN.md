<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="128">

# kojo-editor

[简体中文](README.md) | **English** | [日本語](README_JA.md)

<img alt="License" src="https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square">
<img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square">
<img alt="Built with" src="https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square">
<img alt="Status" src="https://img.shields.io/badge/status-v0.4.0--beta.1_in_progress-f0a441?style=flat-square">

> A structure-aware editor for Kojo (call-name script) authors.
> Thousands of script files, tens of thousands of functions —
> browse, validate, write, and replay, all in one place.
> No more "Notepad + full-text search".

<img src="docs/assets/sugar-view.png" alt="kojo-editor main window: kojo file tree and function tree on the left, .kojo language editing view on the right" width="900">

</div>

---

## Why

The Kojo ecosystem of era games (eraTW and friends) has grown enormous:
2,000+ script files and 90,000+ functions. Yet the tools authors work with
are still Notepad and grep.

Which means, every day:

- One wrong letter in a function name and **an entire script silently dies** —
  nobody speaks in-game, and nothing reports an error;
- Want to know when a line of dialogue triggers? Full-text search, then digging
  through dozens of same-named functions;
- Changing one line means "launch the game → grind to the right state →
  eyeball it" — deep conditions cost fifteen minutes of grinding;
- File encodings are all over the place, and one bad save ruins the text.

kojo-editor turns all of this into "open it and see, save it and know".

## What it does

**🗂 Structured browsing**
Point it at your game directory: script files grouped by character, functions
expanded as a "character → family → face" tree with condition badges at a
glance. 90,000+ functions indexed in seconds.

**✅ Mistakes surface immediately**
Misspelled function names, incomplete families, malformed syntax — the
convention checker lists every problem; click one to jump straight to the
offending line. Errors no longer fail silently.

**✍️ Write in the ".kojo language"**
A writing language designed for Kojo, with a natural Chinese feel like
`如果 好感度 ≤ 5：` ("if affection ≤ 5:"). On save it compiles back to the
script format the game reads natively — original encoding and line endings
preserved, byte for byte. Prefer hand-writing? Both styles mix freely.

**▶ State replay**
Pick a save file and a character: every trigger condition's truth value and
branch outcome laid out in a panel. Test your writing without grinding the game.

**💉 State injection**
Need a specific affection value for testing? Write it into a **test save** —
two-step confirmation, automatic backup, read-back verification. Real saves
and the game itself stay read-only, always.

**🔒 Read-only guardrails**
The entire game directory is write-protected. Where writes are allowed, and
where backups land, is always your explicit call.

**⬆ Auto-update** (shipping with v0.4.0-beta.1)
Check for updates and install from the settings page — no reinstallers.

## Installation

Building from source for now (prebuilt installers arrive with v0.4.0-beta.1):

```bash
# Prerequisites: Node.js 22+ and the Rust toolchain (rustup)
pnpm install
pnpm --filter @kojo/app tauri dev   # first build takes ~20-30 min
```

First launch: pick your game directory → automatic indexing → done.
Everything except writing works without granting write permission
(browsing, checking, and replay are all read-only).

## Development

```bash
pnpm test               # full suite (2473+ passing; integration cases auto-skip without a game directory)
pnpm typecheck          # type checks (root + app)
pnpm audit:decoupling   # "everything is a plugin" decoupling audit
```

The architecture is **everything-is-a-plugin**: the kernel knows nothing about
any specific game — adding a game means adding one adapter plugin.
Design details live in [ARCHITECTURE.md](docs/ARCHITECTURE.md);
contribution workflow in [AGENTS.md](AGENTS.md).

## Roadmap

| Version | Scope | Status |
|---|---|---|
| v0.1 | Kernel + plugin runtime + desktop shell | ✅ |
| v0.2 | Validation / navigation / condition extraction / replay / injector | ✅ |
| v1.0–v1.1 | Snapshot replay + state injector | ✅ |
| v0.3 | .kojo language end-to-end (edit, compile, save) | ✅ |
| v0.4.0-beta.1 | Save loop · file watching · auto-update · settings · packaging | 🚧 In progress |

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/Poboking/kojo-editor/issues).

Developer: [**Poboking**](https://github.com/Poboking)
<a href="https://github.com/Poboking"><img src="https://github.com/Poboking.png" width="24" alt="Poboking" style="border-radius: 50%"></a>

## License

[GPL-3.0-or-later](LICENSE) (kernel and tool code).

This repository ships no game content — screenshots and test data come from a
locally installed copy of the game. Thanks to eraTW and the entire era
community for years of creative work.
