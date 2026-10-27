import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_PANEL_KEYBINDING_SPECS } from '../src/ui/keybinding-specs-commands';
import { KEYBINDING_CATEGORY_ORDER, KEYBINDING_SPECS } from '../src/ui/keybinding-specs';
import { parseKeybinding } from '../src/ui/commands';

/**
 * 批次 E（WS-14 编辑器组 / WS-16 命令面板覆盖面）的**覆盖面闸门**。
 *
 * 这一批的失败模式很具体：命令写完了、键也按得下去，但**没进键位注册表**——
 * 于是快捷键页看不见它（作者改不了键，只能记住出厂那一下）。这种缺陷功能测试抓不到
 * （命令照样跑得通），只能拿源码对表。口径照 `keybindings-specs-split.test.ts`：
 * 读源码扫 id，不启 React。
 */

const readSrc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/ui/${name}`, import.meta.url)), 'utf8');

/** 本批新增（或补齐入口）的命令 id —— 一条都不许从键位表里漏出去 */
const BATCH_E_COMMANDS: readonly string[] = [
  // WS-14 编辑器组：聚焦 / 组间切换 / 键盘调分隔条
  'workbench.focusGroup1',
  'workbench.focusGroup2',
  'workbench.focusGroup3',
  'workbench.focusGroup4',
  'workbench.nextEditorGroup',
  'workbench.prevEditorGroup',
  'workbench.enlargeActiveGroup',
  'workbench.shrinkActiveGroup',
  // WS-16 工作台式动作：过去只有鼠标入口的那几枚
  'workbench.focusExplorer',
  'workbench.closeProject',
  'workbench.openProjectFolder',
  'workbench.openRecentProjects',
  'workbench.showFileInOsExplorer',
];

const MERGED_SPECS = [...KEYBINDING_SPECS, ...COMMAND_PANEL_KEYBINDING_SPECS];

/**
 * 两半合并后的查表（`keybindings.ts` 运行期用的就是这张完整表）。
 * 本测试刻意不 import `./keybindings`：那会把 localStorage 运行期拖进来，
 * 而这里要的只是「表里有没有这一条」这一件事实。
 */
const specOf = (id: string) => MERGED_SPECS.find((s) => s.id === id);

describe('批次 E · 命令都进了键位注册表', () => {
  it('WS-14/WS-16 每条命令都在键位表里，且标题/分类非空（缺一条 = 快捷键页看不见它）', () => {
    for (const id of BATCH_E_COMMANDS) {
      const spec = specOf(id);
      expect(spec, `键位表里没有 ${id}`).not.toBeUndefined();
      expect(spec!.title, `${id} 没有中文标题`).not.toBe('');
      expect(spec!.category, `${id} 没有分类`).not.toBe('');
    }
  });

  it('带缺省键的条目都是**可解析的单段和弦**（和弦序列走不了改键，不许混进这批）', () => {
    const withKeys = BATCH_E_COMMANDS.map((id) => [id, specOf(id)?.keys] as const).filter(
      (pair) => pair[1] !== undefined,
    );
    expect(withKeys.length).toBeGreaterThanOrEqual(6); // 8 枚组命令 + 聚焦资源管理器
    for (const [id, keys] of withKeys) {
      expect(keys!.includes(' '), `${id} 的缺省键不该是和弦序列`).toBe(false);
      expect(parseKeybinding(keys!), `${id} 的 ${keys} 解析不出来`).not.toBeNull();
    }
  });

  it('新增的缺省键与全表不撞键（撞键 = 一枚键位两枚命令，先注册那条赢，作者读到的是"键坏了"）', () => {
    const fresh = MERGED_SPECS.filter((s) => BATCH_E_COMMANDS.includes(s.id) && s.keys !== undefined);
    expect(fresh.length).toBeGreaterThan(0);
    for (const s of fresh) {
      const clash = MERGED_SPECS.filter((x) => x.keys === s.keys && x.id !== s.id).map((x) => x.id);
      expect(clash, `${s.id} 的 ${s.keys} 与它们撞键`).toEqual([]);
    }
  });

  it('键位表里出现的每个分类都在分类序表里（漏一个就被排到最后）', () => {
    for (const category of new Set(MERGED_SPECS.map((s) => s.category))) {
      expect(KEYBINDING_CATEGORY_ORDER, category).toContain(category);
    }
  });

  it('接线源码里两条腿都在：ProjectView 发组命令、ShellLayout 发工作台命令（表配了但没接线同样是空命令）', () => {
    const projectView = readSrc('ProjectView.tsx');
    const shellLayout = readSrc('ShellLayout.tsx');
    // 动态 id 那族由 map 生成（workbench.focusGroup${n}），源码里就是模板串
    expect(projectView).toContain('workbench.focusGroup${n}');
    expect(projectView).toContain('onFocusGroupOrdinal');
    expect(projectView).toContain('onCycleActiveGroup');
    expect(projectView).toContain('onResizeActiveGroup');
    expect(shellLayout).toContain('workbench.focusExplorer');
    expect(shellLayout).toContain('workbench.closeProject');
    expect(shellLayout).toContain('workbench.openRecentProjects');
    expect(shellLayout).toContain('workbench.showFileInOsExplorer');
  });

  it('组命令自陈「工作台」分类（不写就吃 `buildCommandRegistry` 的缺省「布局」⇒ 两处两个分类）', () => {
    const projectView = readSrc('ProjectView.tsx');
    const block = projectView.slice(
      projectView.indexOf('编辑器组聚焦与键盘调分隔条'),
      projectView.indexOf('宿主追加的命令（K2-MIGRATE-MOUNT'),
    );
    expect(block).not.toBe(''); // 找不到那一段就是整族命令被挪走了，闸门要看住
    expect(block.split("category: '工作台'").length - 1).toBeGreaterThanOrEqual(3);
  });
});
