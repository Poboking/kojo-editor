/**
 * 未落盘草稿（KW-16B，2026-11-03）——「新建即可写、落盘才命名」这一格的判据。
 *
 * 钉四件事（对应四条承诺）：
 *  ① **标签键这一格**：`untitled:N` 的序号现算、显示名单源（标签 / 菜单 / 关闭确认框同一把尺子）、
 *     真实路径的标签名逐字不变（搬家不许顺手改别人的读数）；
 *  ② **不静默**：草稿恒脏 ⇒ 关窗确认框点得出它的中文名；会话快照与最近文件都不收它
 *     （收了就是承诺"重开还在"，而重开时它是空的）；
 *  ③ **落盘不换通道**（铁律 5/6 的取证）：草稿的"保存"复用 1028 那条另存为腿——
 *     对话框只交回路径、写盘过 `judgeSaveAs` 的域外拒绝；本批**零新增**写原语
 *     （Rust / 桥 / 内核三层没有一枚 `untitled` 相关的命令或参数）；
 *  ④ **开机图零进图**：`untitled-draft.ts` 只在懒边（`import('./ProjectView')` 之下），
 *     静态闭包一枚文件都不许多（现闸 201 文件顶格，见 `ps10-eager-graph.test.ts`）。
 *
 * 形态先例：源码接线闸照 `file-save-as.test.ts` 末组，SSR 形状锁照 `tab-rail-render.test.ts`。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UNTITLED_PREFIX, isUntitledPath, tabName } from '../src/ui/tabs-ops';
import {
  NEW_UNTITLED_DRAFT_COMMAND,
  nextUntitledPath,
  untitledDraftFileName,
} from '../src/ui/untitled-draft';
import { serializeGroups, initialEditorGroups, restoreGroups } from '../src/ui/editor-groups';
import { editabilityOf, tabRailsOf, RAIL_CLASS } from '../src/ui/editor-editability';
import { judgeSaveAs, saveAsFileName } from '../src/ui/file-save-as';
import { UnsavedFilesConfirmDialog } from '../src/ui/UnsavedFilesConfirmDialog';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const readSource = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const DRAFT = `${UNTITLED_PREFIX}1`;
const DRAFT_3 = `${UNTITLED_PREFIX}3`;
const REAL = 'D:/works/口上/新作.ERB';

describe('① 标签键这一格（前缀 / 序号 / 显示名）', () => {
  it('草稿键认得自己，真实路径一律不认（这把尺子不许误伤盘上文件）', () => {
    expect(isUntitledPath(DRAFT)).toBe(true);
    expect(isUntitledPath(UNTITLED_PREFIX)).toBe(true);
    expect(isUntitledPath(REAL)).toBe(false);
    // 相对路径 / 名字里带 "untitled" 的真文件都不是草稿
    expect(isUntitledPath('D:/x/untitled:1.ERB')).toBe(false);
    expect(isUntitledPath('untitleds/1.txt')).toBe(false);
  });

  it('序号从 1 起、按当下标签表现算，且不因"关掉过一枚"而凭空跳号', () => {
    expect(nextUntitledPath([])).toBe(`${UNTITLED_PREFIX}1`);
    expect(nextUntitledPath([REAL])).toBe(`${UNTITLED_PREFIX}1`);
    expect(nextUntitledPath([DRAFT, REAL])).toBe(`${UNTITLED_PREFIX}2`);
    // 真源就是标签表本身（没有模块级计数器）：只剩 1 时下一枚还是 2，不是"上次涨到哪儿了"
    expect(nextUntitledPath([`${UNTITLED_PREFIX}1`])).toBe(`${UNTITLED_PREFIX}2`);
    expect(nextUntitledPath([`${UNTITLED_PREFIX}7`, DRAFT])).toBe(`${UNTITLED_PREFIX}8`);
  });

  it('脏键不参与取最大（损坏容忍：不抛、不 NaN 落进标签表）', () => {
    expect(nextUntitledPath([UNTITLED_PREFIX, `${UNTITLED_PREFIX}abc`, `${UNTITLED_PREFIX}-3`])).toBe(
      `${UNTITLED_PREFIX}1`,
    );
    expect(nextUntitledPath([`${UNTITLED_PREFIX}2.5`, DRAFT])).toBe(`${UNTITLED_PREFIX}3`);
  });

  it('显示名走 `tabName` 这一处（标签 / 标签列表菜单 / 关闭确认框共用），真实路径逐字不变', () => {
    expect(tabName(DRAFT_3)).toBe('未命名草稿 3');
    expect(tabName(UNTITLED_PREFIX)).toBe('未命名草稿');
    expect(tabName(REAL)).toBe('新作.ERB');
    expect(tabName('C:/games/eratw/script/借阅.ERB')).toBe('借阅.ERB');
  });

  it('落盘预填名是「未命名草稿-N.txt」——没有扩展名就没有语言面，工具不替作者猜哪一种', () => {
    expect(untitledDraftFileName(DRAFT_3)).toBe('未命名草稿-3.txt');
    expect(untitledDraftFileName(UNTITLED_PREFIX)).toBe('未命名草稿.txt');
  });
});

describe('② 不静默：档位、色轨、快照与最近文件', () => {
  it('草稿这一档：能动笔、不在任何目录里、档位是 `untitled`（两道轴都问不到它）', () => {
    const grade = editabilityOf({
      path: DRAFT,
      unlockedPaths: new Set<string>(),
      workspaceRoots: [],
      directMode: false,
      writable: () => false,
    });
    expect(grade.canEdit).toBe(true);
    expect(grade.inWorkspace).toBe(false);
    expect(grade.grade).toBe('untitled');
    // canEdit ≠ 能落盘：写允许域那把尺子对真实路径的回答一个字没变（同一次调用里的对照）
    const real = editabilityOf({
      path: REAL,
      unlockedPaths: new Set<string>(),
      workspaceRoots: [],
      directMode: false,
      writable: () => false,
    });
    expect(real.canEdit).toBe(false);
    expect(real.grade).toBe('read-only');
  });

  it('色轨落在既有那一族里（`rail-untitled`），不给色的是只读档而不是草稿档', () => {
    expect(RAIL_CLASS.untitled).toBe('rail-untitled');
    type RailKernel = Parameters<typeof tabRailsOf>[0];
    const kernel = {
      workspaces: { projectDirs: () => [] },
      io: { isWritable: () => false },
    } as unknown as RailKernel;
    const rails = tabRailsOf(kernel, [DRAFT, REAL]);
    expect(rails.get(DRAFT)?.railClass).toBe('rail-untitled');
    expect(rails.get(REAL)).toBeUndefined();
    expect(rails.get(DRAFT)?.hint).toContain('未落盘');
  });

  it('草稿不进会话快照，真实标签逐字不动；active 落在草稿上时由 `restoreGroups` 既有规则兜底', () => {
    const base = initialEditorGroups();
    const state = {
      ...base,
      groups: [{ ...base.groups[0]!, tabs: [REAL, DRAFT], active: DRAFT }],
    };
    const snap = serializeGroups(state);
    expect(snap.groups[0]!.tabs).toEqual([REAL]);
    // 快照里 active 仍指向被丢掉的草稿 ⇒ restore 那条「active 不在 tabs 里就落 tabs[0]」自兜
    expect(restoreGroups(snap)?.groups[0]!.active).toBe(REAL);
    // 全是草稿的一组 ⇒ 空 tabs ⇒ 空组不进快照恢复（`restoreGroups` 过滤空组）
    const onlyDraft = { ...base, groups: [{ ...base.groups[0]!, tabs: [DRAFT], active: DRAFT }] };
    expect(restoreGroups(serializeGroups(onlyDraft))).toBeNull();
  });

  it('关窗确认框点名「未命名草稿 N」（拿的是 tabName 那把尺子，不是一个像 bug 的 `untitled:1`）', () => {
    const html = renderToStaticMarkup(
      h(UnsavedFilesConfirmDialog, { paths: new Set([DRAFT_3, REAL]), onDecide: () => undefined }),
    );
    expect(html).toContain('未命名草稿 3');
    expect(html).toContain('新作.ERB');
    expect(html).not.toContain(UNTITLED_PREFIX);
    expect(html).toContain('2 个文件有未保存的修改');
  });

  it('接线取证：新建入口两条（命令面板 + 标签栏那颗）、空态那颗、Ctrl+S 的落点通道都接上了', () => {
    const pv = readSource('packages/app/src/ui/ProjectView.tsx');
    expect(pv).toContain(`id: NEW_UNTITLED_DRAFT_COMMAND`);
    expect(pv).toContain('新建未命名草稿');
    expect(pv).toContain('run: () => stableNewDraft()');
    expect(pv).toContain('onNewDraftClick={stableNewDraft}');
    expect(pv).toContain('onSaveDraft={stableSaveDraft}');
    const bar = readSource('packages/app/src/ui/tabs-bar.tsx');
    expect(bar).toContain('onNewDraftClick?: () => void');
    expect(bar).toContain('aria-label="新建未命名草稿"');
    // 键位登记在懒半（开机图不吃字节），且刻意不占缺省键——`Ctrl+N` 已给「新建口上文件」
    const lazy = readSource('packages/app/src/ui/keybinding-specs-commands.ts');
    expect(lazy).toContain(`id: '${NEW_UNTITLED_DRAFT_COMMAND}'`);
    expect(lazy).not.toContain(`id: '${NEW_UNTITLED_DRAFT_COMMAND}', title: '新建未命名草稿', category: '工作台', keys:`);
  });

  it('EditorPane：草稿不读盘（空正文注入）、保存先于写允许域判定分叉、没有盘可重载时明说', () => {
    const ep = readSource('packages/app/src/ui/EditorPane.tsx');
    expect(ep).toContain('isUntitledPath(filePath)');
    expect(ep).toContain("eol: 'LF' }");
    expect(ep).toContain('if (isUntitledPath(path)) {');
    expect(ep).toContain('onSaveDraftRef.current?.(path)');
    expect(ep).toContain('「重新加载」无处可读');
    // 落成才报 saved；取消/域外/没有对话框 ⇒ failed（关标签那条「保存并关闭」读这一枚布尔）
    expect(ep).toContain("if (ok) return { path, status: 'saved' };");
  });
});

describe('③ 落盘不换通道（铁律 5/6 取证）', () => {
  it('草稿的保存落点仍过 `judgeSaveAs`：域外位置诚实拒绝，一字不落', () => {
    const decision = judgeSaveAs({
      currentPath: DRAFT,
      candidate: 'C:/games/eratw/script/借阅.ERB',
      targetWritable: false,
      hostBlocked: false,
      targetHasLiveBuffer: false,
      targetExistsOnDisk: false,
      dialogConfirmsOverwrite: true,
    });
    expect(decision.kind).toBe('reject');
    // 拒绝文案点名的出路是『导出』/加根，而不是"再来一条通道"
    expect(decision.kind === 'reject' ? decision.reason : '').toContain('exportFile');
  });

  it('域内落点照常放行（同一条判据不因"源没在盘上"而少问一道闸）', () => {
    const decision = judgeSaveAs({
      currentPath: DRAFT,
      candidate: REAL,
      targetWritable: true,
      hostBlocked: false,
      targetHasLiveBuffer: false,
      targetExistsOnDisk: false,
      dialogConfirmsOverwrite: true,
    });
    expect(decision).toEqual({ kind: 'proceed', target: REAL, overwrite: false });
  });

  it('另存为的预填名认草稿这一格（对话框里作者看到的是中文名）', () => {
    expect(saveAsFileName(DRAFT_3)).toBe('未命名草稿-3.txt');
    expect(saveAsFileName(REAL)).toBe('新作.ERB');
  });

  it('零新增写原语：Rust / 桥 / 内核三层都不认识 untitled，宿主侧也不许拿 exportFile 当草稿通道', () => {
    for (const rel of [
      'packages/app/src-tauri/src/lib.rs',
      'packages/app/src/bridge/tauri-bridge.ts',
      'packages/kernel/src/io.ts',
    ]) {
      expect(readSource(rel).toLowerCase()).not.toContain('untitled');
    }
    // 草稿那两条腿里一枚 `exportFile` 都不许出现（域外写通道只有导出，且它不属于保存）
    const draft = readSource('packages/app/src/ui/untitled-draft.ts');
    const ep = readSource('packages/app/src/ui/EditorPane.tsx');
    expect(draft).not.toContain('exportFile');
    expect(ep.slice(ep.indexOf('if (isUntitledPath(path)) {'), ep.indexOf('if (isUntitledPath(path)) {') + 900)).not.toContain('writeText');
  });
});

describe('④ 开机图零进图（懒边之下）', () => {
  it('`untitled-draft.ts` 不在 main.tsx 的静态闭包里（文件闸 201 顶格，新进图即红）', () => {
    const graph = eagerFilesFrom('packages/app/src/main.tsx');
    expect(graph.some((f) => f.endsWith('ui/untitled-draft.ts'))).toBe(false);
    // 而它服务的三处消费点全在懒面（ProjectView / EditorPane / tabs-bar 都不在开机图）
    expect(graph.some((f) => f.endsWith('ui/ProjectView.tsx'))).toBe(false);
    expect(graph.some((f) => f.endsWith('ui/EditorPane.tsx'))).toBe(false);
  });

  it('判据不空转：同一条走图规则确实认得开机图里的常驻件', () => {
    const graph = eagerFilesFrom('packages/app/src/main.tsx');
    expect(graph.some((f) => f.endsWith('ui/tabs-ops.ts'))).toBe(true);
    expect(graph.some((f) => f.endsWith('ui/App.tsx'))).toBe(true);
  });
});

/* ------------------------------ 走图（与本仓 ps10 同一套擦除规则） ------------------------------ */

const STATIC_IMPORT_RE = /(?:^|\n)\s*import\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|\n)\s*export\s+(?!type\b)(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;

function hasValueBinding(clause: string): boolean {
  return clause.split(',').some((p) => p.trim() !== '' && !/^\s*type\b/.test(p.trim()));
}

/** 从入口走一遍**静态**图（`.css` / `?worker` 不进主线程 JS 图；动态 import 不跟） */
function eagerFilesFrom(entryRel: string): string[] {
  const relOf = (abs: string): string => path.relative(repoRoot, abs).split(path.sep).join('/');
  const seen = new Set<string>();
  const visit = (abs: string): void => {
    const rel = relOf(abs);
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(abs, 'utf8');
    const specs = new Set<string>();
    for (const m of src.matchAll(STATIC_IMPORT_RE)) if (hasValueBinding(m[1]!)) specs.add(m[2]!);
    for (const m of src.matchAll(BARE_IMPORT_RE)) specs.add(m[1]!);
    for (const m of src.matchAll(EXPORT_FROM_RE)) specs.add(m[1]!);
    for (const s of specs) {
      if (s.includes('?worker') || s.endsWith('.css')) continue;
      const base = s.startsWith('@kojo/')
        ? path.resolve(repoRoot, 'packages/app', s.replace('@kojo/plugin-api', 'plugin-api/src/index.ts'))
        : path.resolve(path.dirname(abs), s.split('?')[0]!);
      for (const c of s.startsWith('@kojo/') ? [] : [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        if (c.startsWith(repoRoot) && readFileSyncExists(c)) {
          visit(c);
          break;
        }
      }
    }
  };
  visit(path.resolve(repoRoot, entryRel));
  return [...seen];
}

function readFileSyncExists(abs: string): boolean {
  try {
    readFileSync(abs);
    return true;
  } catch {
    return false;
  }
}
