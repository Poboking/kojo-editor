<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

[简体中文](README.md) | **English** | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Built with](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![Downloads](https://img.shields.io/github/downloads/Poboking/kojo-editor/total?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**An editor for era-series game script sources (`.ERB` / `.kojo`).**  
Find the function you need, read other people's scripts, get told while you type, ship to the game in one click. Windows 10 / 11.

</div>

<div align="center">
  <img src="docs/assets/erb-definition.gif" width="760" alt="Go to definition">
  <br><sub>Put the cursor on a call site, press <code>F12</code>, land on the definition in <b>another file</b></sub>
</div>

## Features

- **Browse by structure**: character → family → face → function, one tree. No need to memorize names like `M_KOJO_K12_MESSAGE_COM_310`.
- **Read other people's `.ERB`**: `IF` / `PRINTFORMW` are displayed as "if …:" and plain lines of dialogue. **Display only — the file is not touched, not one byte**.
- **The usual IDE moves**: go to definition, find references, rename (across files), hover for the author's comments, parameter hints, jump to symbol.
- **Mistakes caught while typing**: wrong function names, incomplete families, a branch with no fallback — a squiggle on the line, click to jump there.
- **Your own work lives separately**: write in your own script project, then **export** a zip to share, or **deploy** it into the game directory.
- **No need to boot the game to check**: state replay tells you whether a line will fire with an existing save; the state injector sets the variables you need first.

## Demo

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/erb-references.gif" width="420" alt="Find references"></td>
    <td valign="middle"><b>Find references</b> <code>Shift+F12</code><br>Before changing one character, see which files call it.</td>
  </tr>
</table>

<table>
  <tr>
    <td valign="middle"><b>Completion</b> <code>Ctrl+Space</code> / as you type<br>Nothing pops inside dialogue, comments or strings — candidates only appear where they make sense.</td>
    <td width="46%" align="center"><img src="docs/assets/erb-completion.gif" width="420" alt="Completion"></td>
  </tr>
</table>

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/editor-folding.gif" width="420" alt="Folding"></td>
    <td valign="middle"><b>Folding</b><br>Collapse by function body or block. A script file with tens of thousands of lines is only readable if it folds.</td>
  </tr>
</table>

<table>
  <tr>
    <td valign="middle"><b>Command palette</b> <code>Ctrl+Shift+P</code><br>Anything the UI can do is searchable here, and this is where you rebind keys.</td>
    <td width="46%" align="center"><img src="docs/assets/editor-palette.gif" width="420" alt="Command palette"></td>
  </tr>
</table>

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/editor-search.gif" width="420" alt="Project-wide search"></td>
    <td valign="middle"><b>Project-wide search</b><br>Use it when you only remember a line of dialogue or a fragment; hits are grouped per file.</td>
  </tr>
</table>

## Interface

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-editor.jpg" width="480" alt="Main window"><br><sub><b>Main window</b></sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-condition-matrix.jpg" width="480" alt="Condition matrix"><br><sub><b>Condition matrix</b> — click a filled cell to jump to the script</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-syntax-reference.jpg" width="480" alt="Syntax tables"><br><sub><b>Syntax tables</b> — how to write it, what it compiles to, what the error says</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-market.jpg" width="480" alt="Script market"><br><sub><b>Script market</b> — install packages published by others</sub></td>
  </tr>
</table>

## Download and install

Get it from [Releases](https://github.com/Poboking/kojo-editor/releases/latest):

- **Installer** `kojo-editor_<version>_x64-setup.exe` — run it and follow the wizard; later versions update from "Settings → Update".
- **Portable** `kojo-editor_<version>_x64-portable.zip` — unzip and run `kojo-editor.exe`, nothing written to the registry. Needs the WebView2 runtime (preinstalled on Windows 11; on Windows 10 you may need to [install it](https://developer.microsoft.com/microsoft-edge/webview2/) first).

Every release ships `SHA256SUMS.txt` so you can verify the download. The installer is **not code-signed**, so Windows may show "protected your PC" on first run — "More info → Run anyway" is the way through.

## First run

1. On the welcome page, click "Select game directory" and pick your eraTW root;
2. it then asks about write access — **say no if you only want to read**; browsing, linting and replay keep working;
3. open a character's `.ERB` from "Script files" on the left — the first time, it asks whether to turn on `.kojo` preview;
4. to write your own: "My script projects" on the left → "+ New".

The full manual (creating a project, export and deploy, choosing a license, the safety notes on state injection) is in
[docs/USER-GUIDE.md](docs/USER-GUIDE.md) (Chinese for now).

## Running from source

```bash
corepack enable
pnpm install
pnpm --filter @kojo/app tauri dev      # development run (first cargo build takes 20–30 min)
pnpm --filter @kojo/app tauri build    # produce the installer
```

Requires Node.js 22, pnpm 11.22.0 and Rust stable (MSVC). The environment matrix, verification commands, plugin and adapter development and the release flow are in [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md).

## FAQ

| Question | Answer |
|---|---|
| Will it damage my game directory? | It is read-only by default; only paths you approve can be written. Files are backed up before each write, and the original encoding and line endings are kept. |
| Which games are supported? | 8 era-series games are wired up. eraTW is the most polished; eraFL keeps its scripts in XML data files; coverage varies for the rest. |
| Does it conflict with editing `.ERB` directly? | No. Native files stay editable as they are; the readable surface syntax is just an optional way to view them. |
| Is there a macOS / Linux build? | Not yet — Windows 10 / 11 x64 only. |
| I installed something and nothing changed in game? | The engine only reads `.ERB`. Use "Export" or "Deploy" instead of copying source files into the game directory. |

## Documentation

| Document | For |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | script authors: how to use it (no implementation detail; Chinese) |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | developers: environment, verification, plugins and adapters, releasing |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) | the `.kojo` language specification |
| [docs/STATE.md](docs/STATE.md) | test and performance readings, known debt |
| [AGENTS.md](AGENTS.md) | rules and commands for AI collaborators |

## Contributing

Welcome. Please read [AGENTS.md](AGENTS.md) first (invariants and collaboration discipline), and skim
[docs/PITFALLS.md](docs/PITFALLS.md) before you start. Adding a game? [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md).
Opening an issue before a pull request saves everyone work.

## License

[GPL-3.0-or-later](LICENSE). The repository contains no game content: the animations and screenshots here come from
synthetic samples, and the real corpora used by tests are only ever read, from directories installed locally and
authorized by the user.

Thanks to eraTW and the whole era community for years of authoring.

Author: [**Poboking**](https://github.com/Poboking) · bugs and ideas welcome in [Issues](https://github.com/Poboking/kojo-editor/issues)
