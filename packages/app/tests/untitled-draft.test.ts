/**
 * 未落盘草稿（KW-16B2，2026-11-03）——「新建即可写、落盘才命名」这一格的判据。
 *
 * 分四组钉（对应四条承诺，随批次逐组补齐）：
 *  ① **标签键这一格**：`untitled:N` 不是路径、序号按当下标签表现算、显示名单源在 `tabName`
 *     （标签 / 菜单 / 关闭确认框同一把尺子），真实路径的读数逐字不变；
 *  ② **这一格不动盘**：不读盘（池的注入腿）、没有盘可重载时明说、空草稿不算脏（VSCode 同形：
 *     没打一个字就没有"丢内容"这回事），写下第一个字才进 `dirtyPaths` ⇒ 三条退出确认链点名它；
 *  ③ **落盘不换通道**（铁律 5/6 取证）：复用 1028 那条已审的另存为腿——对话框只交回路径、
 *     落盘过 `judgeSaveAs` 的写域闸，取消 ⇒ 一个字节都不写；本批零新增写原语；
 *  ④ **开机图零进图**：新逻辑全在懒边，文件闸 201 顶格不许多一枚。
 *
 * 形态先例：走图规则照 `ps10-eager-graph.test.ts`，源码接线闸照 `file-save-as.test.ts` 末组，
 * SSR 形状锁照 `tab-rail-render.test.ts`（真组件 + `renderToStaticMarkup`）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNTITLED_PREFIX, isUntitledPath, tabName } from '../src/ui/tabs-ops';
import { nextUntitledPath, untitledDraftFileName } from '../src/ui/untitled-draft';
import { initialEditorGroups, restoreGroups, serializeGroups } from '../src/ui/editor-groups';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const readSource = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const DRAFT_1 = `${UNTITLED_PREFIX}1`;
const DRAFT_3 = `${UNTITLED_PREFIX}3`;
const REAL = 'D:/works/口上/新作.ERB';

describe('① 标签键这一格（前缀 / 序号 / 显示名）', () => {
  it('草稿键认得自己，盘上件一律不认（这把尺子不许误伤真实路径）', () => {
    expect(isUntitledPath(DRAFT_1)).toBe(true);
    expect(isUntitledPath(REAL)).toBe(false);
    // 名字里带 "untitled" 的真文件、相对路径、Windows 盘符写法都不是草稿
    expect(isUntitledPath('D:/x/untitled:1.ERB')).toBe(false);
    expect(isUntitledPath('untitleds/1.txt')).toBe(false);
    expect(isUntitledPath('./untitled:9')).toBe(false);
  });

  it('序号从 1 起、按当下标签表现算：没有模块级计数器，关掉一枚也不凭空跳号', () => {
    expect(nextUntitledPath([])).toBe(DRAFT_1);
    expect(nextUntitledPath([REAL])).toBe(DRAFT_1);
    expect(nextUntitledPath([DRAFT_1, REAL])).toBe(`${UNTITLED_PREFIX}2`);
    // 真源就是标签表本身：只剩 1 时下一枚还是 2，不是"上次涨到哪儿了"
    expect(nextUntitledPath([`${UNTITLED_PREFIX}7`, DRAFT_1])).toBe(`${UNTITLED_PREFIX}8`);
  });

  it('脏键不参与取最大（损坏容忍：不抛、不把 NaN 落进标签表）', () => {
    expect(nextUntitledPath([UNTITLED_PREFIX, `${UNTITLED_PREFIX}abc`, `${UNTITLED_PREFIX}-3`])).toBe(DRAFT_1);
    // `2.5` 不是安全整数 ⇒ 跳过（不 `Math.floor` 蒙它一档），最大值只剩标签表里那枚 1
    expect(nextUntitledPath([`${UNTITLED_PREFIX}2.5`, DRAFT_1])).toBe(`${UNTITLED_PREFIX}2`);
  });

  it('显示名单源：草稿给中文名，真实路径的末段读数逐字不变（搬家不许顺手改别人的口径）', () => {
    expect(tabName(DRAFT_3)).toBe('未命名草稿 3');
    expect(tabName(UNTITLED_PREFIX)).toBe('未命名草稿');
    expect(tabName(REAL)).toBe('新作.ERB');
    expect(tabName('C:/games/eratw/script/借阅.ERB')).toBe('借阅.ERB');
    expect(tabName('借阅.ERB')).toBe('借阅.ERB');
  });

  it('落盘预填名是「未命名草稿-N.txt」：没有扩展名就没有语言面，工具不替作者猜哪一种', () => {
    expect(untitledDraftFileName(DRAFT_3)).toBe('未命名草稿-3.txt');
    expect(untitledDraftFileName(UNTITLED_PREFIX)).toBe('未命名草稿.txt');
  });
});

describe('② 这一格不动盘：不进快照、不占最近文件、不冒充盘上件', () => {
  it('草稿不进会话快照（记下来就是承诺"重开还在"，而重开时它是空的），真实标签一位不动', () => {
    const base = initialEditorGroups();
    const state = { ...base, groups: [{ ...base.groups[0]!, tabs: [REAL, DRAFT_1], active: DRAFT_1 }] };
    expect(serializeGroups(state).groups[0]!.tabs).toEqual([REAL]);
    // 快照里 active 指向被丢掉的草稿 ⇒ `restoreGroups` 那条「active 不在 tabs 里就落 tabs[0]」自兜
    expect(restoreGroups(serializeGroups(state))?.groups[0]!.active).toBe(REAL);
    // 全是草稿的一组 ⇒ 空 tabs ⇒ 空组不进恢复（既有规则，不为本批开后门）
    const onlyDraft = { ...base, groups: [{ ...base.groups[0]!, tabs: [DRAFT_1], active: DRAFT_1 }] };
    expect(restoreGroups(serializeGroups(onlyDraft))).toBeNull();
  });

  it('接线取证：EditorPane 这一格真的不碰盘——不读盘、不接恢复孤儿、没有盘可重载时明说', () => {
    const ep = readSource('packages/app/src/ui/EditorPane.tsx');
    // 建 model 走池的注入腿（空正文），且恢复腿对草稿一律不接管（同键 journal 是上一轮的孤儿）
    expect(ep).toContain('const recovered = isUntitledPath(filePath) ? null : peekRecoveredContent(filePath);');
    expect(ep).toContain("? { text: '', encoding: 'utf-8', eol: 'LF' }");
    // 「重新加载」不拿一次读盘失败冒充答案
    expect(ep).toContain('if (isUntitledPath(path)) {');
    expect(ep).toContain('「重新加载」无处可读');
    // 空草稿不脏（写下第一个字才进 dirtyPaths）；真实路径的判据一个字没改
    expect(ep).toContain('if (isUntitledPath(path)) return entry.model.getValueLength() > 0;');
    expect(ep).toContain('return entry.model.getAlternativeVersionId() !== base;');
    // 保存那颗对草稿渲染（草稿的"保存"= 给它一个落点），且不吃宿主写域置灰
    expect(ep).toContain('{(isUntitledPath(filePath) || kernel.io.isWritable(filePath)) ? (');
  });

  it('草稿不进最近文件（持久记录 + 没有落点 = 欢迎页上一枚点不开的幽灵）', () => {
    const app = readSource('packages/app/src/ui/App.tsx');
    const at = app.indexOf('const recordRecentFile = useCallback');
    expect(at).toBeGreaterThan(-1);
    expect(app.slice(at, at + 700)).toContain('if (isUntitledPath(path)) return;');
  });
});
