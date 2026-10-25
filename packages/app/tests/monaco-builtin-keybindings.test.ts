/**
 * Monaco 内建键位表单测（1020 编辑器体感批，用户反馈项 8）。
 *
 * 这一张表唯一的风险是**编造键位**：写一条作者按下去没反应的"内建键"，比不列更坏。
 * 所以除了形状判据，这里把每条的缺省键回到 monaco-editor@0.57.0 的 vendor 源码里对账——
 * 打包产物把 `KeyMod`/`KeyCode` 写成裸数字（注释里的名字即取证依据），本测试先把注释剥掉，
 * 再把 `primary: A | B | C` 的OR串求和，与「本表这一串修饰 + 主键」的数字和逐条相等。
 *
 * 两条判据一起才算证据：①该文件里确有那个命令 id；②该文件里确有这一串 primary。
 * （单看 ① 会漏掉"id 在、默认键被上游改过"，单看 ② 会认成"任意一条注册"。）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MONACO_BUILTIN_CATEGORY,
  MONACO_BUILTIN_COUNT,
  monacoBuiltinRows,
} from '../src/ui/monaco-builtin-keybindings';
import { parseKeybinding } from '../src/ui/commands';
import { KEYBINDING_SPECS } from '../src/ui/keybindings';

const vendor = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../node_modules/monaco-editor/esm/vs/${rel}`, import.meta.url)), 'utf8')
    // vendor 把枚举名注释在数字后面（`512 /* KeyMod.Alt */`）；剥注释才能安全切 OR 串
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** KeyCode 编号（读自 base/common/keyCodes.js 的映射表；写错编号 ⇒ 对账直接红） */
const KEY_CODE: Record<string, number> = {
  f2: 60,
  f8: 66,
  f12: 70,
  space: 10,
  arrowup: 16,
  arrowdown: 18,
  arrowleft: 15,
  arrowright: 17,
  enter: 3,
  a: 31,
  c: 33,
  d: 34,
  f: 36,
  g: 37,
  j: 40,
  k: 41,
  l: 42,
  o: 45,
  u: 51,
  v: 52,
  x: 54,
  '0': 21,
  '1': 22,
  '2': 23,
  '3': 24,
  '4': 25,
  '5': 26,
  '6': 27,
  '7': 28,
  '/': 90,
  '[': 92,
  ']': 94,
  '\\': 93,
};

const MOD_BIT: Record<string, number> = { ctrl: 2048, shift: 1024, alt: 512 };

/** `'ctrl+shift+k'` ⇒ 3113（vendor 里那一串 `primary:` 的数字和） */
function primaryValue(chord: string): number {
  const parts = chord.split('+');
  const key = parts.at(-1)!;
  const code = KEY_CODE[key];
  expect(code, `测试表里没有 KeyCode '${key}' 的编号`).toBeTypeOf('number');
  return parts.slice(0, -1).reduce((acc, m) => acc + (MOD_BIT[m] ?? 0), 0) + code!;
}

/** 空格分隔的和弦（`'ctrl+k ctrl+0'`）⇒ 两段各自的数字和 */
function chordPairOf(keys: string): [number, number] {
  const parts = keys.split(/\s+/);
  expect(parts, `和弦应正好两段：${keys}`).toHaveLength(2);
  return [primaryValue(parts[0]!), primaryValue(parts[1]!)];
}

/** 该文件里出现过的全部 primary 数字和 */
function primariesIn(src: string): number[] {
  return [...src.matchAll(/primary:\s*([0-9]+(?:\s*\|\s*[0-9]+)*)/g)].map((m) =>
    m[1]!.split('|').reduce((acc, part) => acc + Number(part.trim()), 0),
  );
}

/** 该文件里出现过的全部 `KeyChord(a, b)` 数字对（两参数都是纯数字表达式；foldLevel 的 `(21+i)` 不匹配，单列） */
function keyChordsIn(src: string): Array<[number, number]> {
  const sum = (s: string | undefined): number =>
    (s ?? '0').split('|').reduce((acc, part) => acc + Number(part.trim()), 0);
  return [...src.matchAll(/KeyChord\(\s*([0-9]+(?:\s*\|\s*[0-9]+)*)\s*,\s*([0-9]+(?:\s*\|\s*[0-9]+)*)\s*\)/g)].map(
    (m) => [sum(m[1]), sum(m[2])] as [number, number],
  );
}

const rows = monacoBuiltinRows();

/** 本表 id → [vendor 命令 id, 注册文件] */
const PROOFS: Readonly<Record<string, readonly [string, string]>> = {
  'monaco.editor.action.revealDefinition': ['editor.action.revealDefinition', 'editor/contrib/gotoSymbol/browser/goToCommands.js'],
  'monaco.editor.action.peekDefinition': ['editor.action.peekDefinition', 'editor/contrib/gotoSymbol/browser/goToCommands.js'],
  'monaco.editor.action.goToImplementation': ['editor.action.goToImplementation', 'editor/contrib/gotoSymbol/browser/goToCommands.js'],
  'monaco.editor.action.goToReferences': ['editor.action.goToReferences', 'editor/contrib/gotoSymbol/browser/goToCommands.js'],
  'monaco.editor.action.rename': ['editor.action.rename', 'editor/contrib/rename/browser/rename.js'],
  'monaco.editor.action.gotoLine': ['editor.action.gotoLine', 'editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'],
  'monaco.editor.action.quickOutline': ['editor.action.quickOutline', 'editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'],
  'monaco.editor.action.jumpToBracket': ['editor.action.jumpToBracket', 'editor/contrib/bracketMatching/browser/bracketMatching.js'],
  'monaco.editor.action.addSelectionToNextFindMatch': ['editor.action.addSelectionToNextFindMatch', 'editor/contrib/multicursor/browser/multicursor.js'],
  'monaco.editor.action.selectHighlights': ['editor.action.selectHighlights', 'editor/contrib/multicursor/browser/multicursor.js'],
  'monaco.editor.action.insertCursorAbove': ['editor.action.insertCursorAbove', 'editor/contrib/multicursor/browser/multicursor.js'],
  'monaco.editor.action.insertCursorBelow': ['editor.action.insertCursorBelow', 'editor/contrib/multicursor/browser/multicursor.js'],
  'monaco.editor.action.deleteLines': ['editor.action.deleteLines', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.moveLinesUpAction': ['editor.action.moveLinesUpAction', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.moveLinesDownAction': ['editor.action.moveLinesDownAction', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.copyLinesUpAction': ['editor.action.copyLinesUpAction', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.copyLinesDownAction': ['editor.action.copyLinesDownAction', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.indentLines': ['editor.action.indentLines', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.outdentLines': ['editor.action.outdentLines', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.commentLine': ['editor.action.commentLine', 'editor/contrib/comment/browser/comment.js'],
  'monaco.editor.action.blockComment': ['editor.action.blockComment', 'editor/contrib/comment/browser/comment.js'],
  'monaco.editor.action.formatDocument': ['editor.action.formatDocument', 'editor/contrib/format/browser/formatActions.js'],
  'monaco.editor.action.triggerSuggest': ['editor.action.triggerSuggest', 'editor/contrib/suggest/browser/suggestController.js'],
  'monaco.editor.action.triggerParameterHints': ['editor.action.triggerParameterHints', 'editor/contrib/parameterHints/browser/parameterHints.js'],
  'monaco.editor.action.marker.next': ['editor.action.marker.next', 'editor/contrib/gotoError/browser/gotoError.js'],
  'monaco.editor.action.marker.prev': ['editor.action.marker.prev', 'editor/contrib/gotoError/browser/gotoError.js'],
  'monaco.editor.action.marker.nextInFiles': ['editor.action.marker.nextInFiles', 'editor/contrib/gotoError/browser/gotoError.js'],
  'monaco.editor.action.marker.prevInFiles': ['editor.action.marker.prevInFiles', 'editor/contrib/gotoError/browser/gotoError.js'],
  // ---- 1026 编辑器内核批：从 monaco-command-specs 桥进来的内核动作（有 Monaco 缺省键的那些） ----
  'monaco.editor.foldAll': ['editor.foldAll', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.unfoldAll': ['editor.unfoldAll', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldRecursively': ['editor.foldRecursively', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.unfoldRecursively': ['editor.unfoldRecursively', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.toggleFold': ['editor.toggleFold', 'editor/contrib/folding/browser/folding.js'],
  // foldLevel1..7 由 vendor 循环注册（`FoldLevelAction.ID(i)`，无字面量 id）→ 见下面单列的证据块
  'monaco.editor.foldLevel1': ['editor.foldLevel1', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldLevel2': ['editor.foldLevel2', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldLevel3': ['editor.foldLevel3', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldLevel4': ['editor.foldLevel4', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldLevel5': ['editor.foldLevel5', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldLevel6': ['editor.foldLevel6', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.foldLevel7': ['editor.foldLevel7', 'editor/contrib/folding/browser/folding.js'],
  'monaco.editor.action.trimTrailingWhitespace': ['editor.action.trimTrailingWhitespace', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.insertLineAfter': ['editor.action.insertLineAfter', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.insertLineBefore': ['editor.action.insertLineBefore', 'editor/contrib/linesOperations/browser/linesOperations.js'],
  'monaco.editor.action.smartSelect.expand': ['editor.action.smartSelect.expand', 'editor/contrib/smartSelect/browser/smartSelect.js'],
  'monaco.editor.action.smartSelect.shrink': ['editor.action.smartSelect.shrink', 'editor/contrib/smartSelect/browser/smartSelect.js'],
  'monaco.editor.action.selectAll': ['editor.action.selectAll', 'editor/browser/editorExtensions.js'],
  'monaco.editor.action.addCommentLine': ['editor.action.addCommentLine', 'editor/contrib/comment/browser/comment.js'],
  'monaco.editor.action.removeCommentLine': ['editor.action.removeCommentLine', 'editor/contrib/comment/browser/comment.js'],
  'monaco.editor.action.clipboardCutAction': ['editor.action.clipboardCutAction', 'editor/contrib/clipboard/browser/clipboard.js'],
  'monaco.editor.action.clipboardCopyAction': ['editor.action.clipboardCopyAction', 'editor/contrib/clipboard/browser/clipboard.js'],
  'monaco.editor.action.clipboardPasteAction': ['editor.action.clipboardPasteAction', 'editor/contrib/clipboard/browser/clipboard.js'],
};

describe('行形状（快捷键页的判据不许漂）', () => {
  it('条数与导出常量一致、id 唯一、分类恒为「Monaco 内建」', () => {
    expect(rows).toHaveLength(MONACO_BUILTIN_COUNT);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) expect(r.category).toBe(MONACO_BUILTIN_CATEGORY);
  });

  it('全部只读 + 恒为「原样」态 + 不参与撞键（这三条决定页面上不出现改键格与「已改」计数）', () => {
    for (const r of rows) {
      expect(r.rebindable, r.id).toBe(false);
      expect(r.state, r.id).toBe('default');
      expect(r.conflictWith, r.id).toBeNull();
    }
  });

  it('每条都有 parseKeybinding 认得的键位串，且展示形非空（芯片画得出来才上表）', () => {
    for (const r of rows) {
      expect(r.keys, r.id).toBeDefined();
      expect(parseKeybinding(r.keys!), `${r.id} → ${r.keys}`).not.toBeNull();
      expect(r.display, r.id).not.toBe('');
    }
  });

  it('id 一律带 monaco. 前缀，且不与宿主注册表撞 id（撞了键位页会长出一行两个身份）', () => {
    const hostIds = new Set(KEYBINDING_SPECS.map((s) => s.id));
    for (const r of rows) {
      expect(r.id.startsWith('monaco.'), r.id).toBe(true);
      expect(hostIds.has(r.id), `与宿主命令撞 id：${r.id}`).toBe(false);
    }
  });
});

describe('每条键位回 vendor 对账（不许凭记忆写）', () => {
  it('表里每一条都有 vendor 出处，出处表不多不少正好覆盖全表', () => {
    const ids = new Set(rows.map((r) => r.id));
    for (const r of rows) expect(PROOFS[r.id], `内建键「${r.id}」没有 vendor 证据`).toBeDefined();
    expect(Object.keys(PROOFS).length).toBe(MONACO_BUILTIN_COUNT);
    for (const id of Object.keys(PROOFS)) expect(ids.has(id), `出处表里多了不在表上的 ${id}`).toBe(true);
  });

  it('逐条命中：该文件里确有那个命令 id，且确有等于这一串的 primary（单键）/ KeyChord（和弦）', () => {
    const cache = new Map<
      string,
      { has: (needle: string) => boolean; primaries: number[]; chords: Array<[number, number]> }
    >();
    for (const r of rows) {
      // foldLevel 无字面量 id（vendor 用 ID(i) 循环注册）→ 单列证据，见下一个 it
      if (r.id.startsWith('monaco.editor.foldLevel')) continue;
      const [vendorId, file] = PROOFS[r.id]!;
      let scanned = cache.get(file);
      if (!scanned) {
        const src = vendor(file);
        scanned = {
          has: (needle: string) => src.includes(needle),
          primaries: primariesIn(src),
          chords: keyChordsIn(src),
        };
        expect(
          scanned.primaries.length + scanned.chords.length,
          `${file} 里找不到任何 primary / KeyChord 注册`,
        ).not.toBe(0);
        cache.set(file, scanned);
      }
      expect(scanned.has(`'${vendorId}'`), `${file} 里没有命令 ${vendorId}`).toBe(true);
      if (r.keys!.includes(' ')) {
        // 和弦（如 Ctrl+K Ctrl+0）：vendor 里写 `KeyChord(a, b)`，比对两个数字和
        const [a, b] = chordPairOf(r.keys!);
        expect(
          scanned.chords.some(([ca, cb]) => ca === a && cb === b),
          `${r.id}（${r.keys}）期望 KeyChord(${a}, ${b})，${file} 没有这一对`,
        ).toBe(true);
      } else {
        const want = primaryValue(r.keys!);
        expect(scanned.primaries.includes(want), `${r.id}（${r.keys}）期望 primary=${want}，${file} 没有这一串`).toBe(true);
      }
    }
  });

  it('折叠到第 N 层 7 档：vendor 用 ID_PREFIX + 循环批量注册（无字面量 id，故单列证据）', () => {
    const src = vendor('editor/contrib/folding/browser/folding.js');
    expect(src).toContain("this.ID_PREFIX = 'editor.foldLevel';");
    expect(src).toContain('this.ID = (level) => FoldLevelAction.ID_PREFIX + level;');
    expect(src).toContain('for (let i = 1; i <= 7; i++)');
    expect(src).toContain('FoldLevelAction.ID(i)');

    const levels = rows.filter((r) => r.id.startsWith('monaco.editor.foldLevel'));
    expect(levels).toHaveLength(7);
  });

  it('宿主注册表没有抢走这些内建键（抢了就不是"内建"而是我们覆写了）', () => {
    const hostKeys = new Set(
      KEYBINDING_SPECS.map((s) => s.keys).filter((k): k is string => k !== undefined && !k.includes(' ')),
    );
    // Ctrl+S 是宿主自己 addCommand 抢下的那一条（Monaco 的内建保存键在此不适用），逐字记在案
    const overridden = new Set(['ctrl+s']);
    for (const r of rows) {
      if (overridden.has(r.keys!)) continue;
      expect(hostKeys.has(r.keys!), `宿主已占用内建键 ${r.keys}（${r.id}）`).toBe(false);
    }
  });
});

describe('列选这个鼠标手势（不是按键，不进表；口径要写清）', () => {
  it('vendor 的判定是「多光标修饰键 + Shift 拖动」或「Alt 拖动」，列选开关开着则普通拖动即列选', () => {
    const src = vendor('editor/browser/view/viewController.js');
    expect(src).toContain('_hasMulticursorModifier(data)');
    expect(src).toContain('this._columnSelect(data.position, data.mouseColumn, true);');
    expect(src).toContain('options.get(28 ');
  });

  it('内建键表里没有鼠标手势（避免"按一个不存在的键"）', () => {
    for (const r of rows) expect(r.keys!, r.id).not.toMatch(/drag|mouse|wheel/);
  });
});
