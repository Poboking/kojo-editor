/**
 * 壳层信息设计批（Wave2 C-1a）的**静态守门**（写法同 `readonly-pill.test.ts` /
 * `condition-matrix-fill-marker.test.ts`：ShellLayout/EditorPane 挂着 Monaco 与整套内核槽位，
 * node 里渲染不出来，而这几条全是结构约定——级联终值、标签上屏、入口收拢，
 * 运行期没有可观测面，只能钉在源码与样式表文本上）。
 *
 * 覆盖审阅 1–5：
 *  1. 教程浮层标题不再被 `.panel h3` 的大写口径把 `.kojo` 顶成 `.KOJO`；
 *  2. 状态栏「项目级约定计数」与「已打开文件问题」两簇分域贴标签 + 分隔线（工包 E：
 *     后一枚的标签改由 `problem-store.PROBLEM_SCOPE` 单源供给，见下面第 ② 组）；
 *  3. 只读胶囊带锁形图标、命中区 ≥24px；只读态的右侧读数说「未修改」不谎报「已保存」；
 *  4. 工具栏分组：「关闭项目」收进项目名旁的更多菜单、重复的「重置布局」退场、分隔件在位；
 *  5. 编辑器工具条路径呈项目相对口径（绝对前缀不上屏、完整路径恒在 title）、
 *     `.kojo 预览` 开关与糖摘要挪到行右。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const css = read('../src/styles-project.css');
const shell = read('../src/ui/ShellLayout.tsx');
const problems = read('../src/ui/ProblemPanel.tsx');
/** 诊断口径的真源（工包 E 之后：状态栏那颗的标签与 tooltip 都从这里出） */
const store = read('../src/ui/problem-store.ts');

/** 取某选择器的**最后一条**规则体（C-1a 整批是文件末尾覆盖块：级联终值由最后出现者定） */
function lastRuleBody(selector: string): string {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  const all = [...css.matchAll(re)];
  return all.at(-1)?.[1] ?? '';
}

describe('① 教程浮层标题豁免面板大写', () => {
  it('.wizard.tutorial h3 显式 text-transform:none（浮层经 PanelBody 包在 .panel 里，继承链实打实存在）', () => {
    expect(lastRuleBody('.wizard.tutorial h3')).toMatch(/text-transform:\s*none/);
  });

  it('.panel h3 本体保持大写（其它面板依赖这条口径，不许顺手删）', () => {
    expect(css).toMatch(/\.panel h3\s*\{[^}]*text-transform:\s*uppercase/);
  });
});

describe('② 状态栏两组诊断分域可辨', () => {
  it('「项目」标签由 CSS ::before 补给 `.sb-diag`（插件 DOM 不许碰，标签仍上屏）', () => {
    expect(lastRuleBody('.sb-diag::before')).toMatch(/content:\s*'项目'/);
    expect(lastRuleBody('.sb-diag::before')).toMatch(/border-right:/);
  });

  it('状态栏小件的可见范围标签来自 problem-store（工包 E：标签与计数同源；两档计数路径都在）', () => {
    // 旧断言钉的是 JSX 里那两个字面「本文件」——而那两个字恰恰是假的（计数是全部已打开文件的
    // 合并值）。现在钉"标签只有一个真源"：JSX 两处都读 PROBLEM_SCOPE.label，字面量住在 store。
    expect(problems.match(/<span className="sb-scope-tag">\{PROBLEM_SCOPE\.label\}<\/span>/g)?.length).toBe(2);
    expect(problems).not.toMatch(/<span className="sb-scope-tag">[^{]/); // 不许再就地写死范围词
    expect(store).toMatch(/label:\s*'已打开'/);
  });

  it('两簇之间有分隔线、命中区 ≥24px；各自 title 口径原文一字不丢（现住在 problem-store）', () => {
    expect(lastRuleBody('.sb-problems')).toMatch(/border-left:\s*1px solid var\(--border\)/);
    expect(lastRuleBody('.sb-problems')).toMatch(/min-height:\s*24px/);
    expect(store).toContain('不含未打开文件与整项目结论 ≠ 项目级约定计数');
    expect(problems).toContain('title={PROBLEM_SCOPE.title}');
  });
});

describe('③ 只读态可见 + 命中区 + 脏读数语义', () => {
  it('.sb-writable 行内 flex、命中区 ≥24px（实测 43×19 低于 24 的那一档被抬起）', () => {
    const body = lastRuleBody('.sb-writable');
    expect(body).toMatch(/display:\s*inline-flex/);
    expect(body).toMatch(/min-height:\s*24px/);
  });

  it('只读胶囊带锁形描边图标（currentColor 随琥珀档；aria-hidden，读屏仍念「只读」）', () => {
    expect(shell).toContain('function LockIcon');
    expect(shell).toMatch(/<button className="sb-writable ro"[\s\S]{0,160}<LockIcon \/>\s*只读/);
  });

  it('只读态右侧读数说「未修改」；有未保存改动仍如实说「未保存」；可写态口径零改动', () => {
    expect(shell).toMatch(/writablePill === 'ro' \? \(\s*'未修改'\s*\)\s*:\s*\(\s*'已保存'/);
    expect(shell).toContain('有未保存修改');
    // readonly-pill 那组的红线不碰：两档胶囊各自仍只出现一次类名字面量
    expect(shell.match(/sb-writable ok/g)).toHaveLength(1);
    expect(shell.match(/sb-writable ro/g)).toHaveLength(1);
  });
});

describe('④ 工具栏分组：项目操作收拢 · 视图开关分离 · 重复入口退场', () => {
  it('工具条不再有裸的「关闭项目」按钮与「重置布局」按钮', () => {
    expect(shell).not.toContain('title="关闭项目"');
    expect(shell).not.toContain('title="重置布局"');
  });

  it('关闭项目收进项目名旁的更多菜单（danger 危险项 + 菜单走共享 ContextMenu，键盘/Esc 口径不另造）', () => {
    expect(shell).toContain("label: '关闭项目', danger: true");
    expect(shell).toContain("from './context-menu'");
    expect(shell).toContain('aria-haspopup="menu"');
    expect(shell).toContain('aria-expanded={projectMenuAt !== null}');
    expect(shell).toContain("ariaLabel=\"项目操作\"");
  });

  it('重置布局功能两入口仍在（命令面板 + 设置页），只是不再占工具条一排', () => {
    expect(shell).toContain("id: 'layout.reset'");
    expect(shell).toContain('onResetLayout={doReset}');
  });

  it('项目操作簇与视图开关簇之间有分隔件，分隔线用 --border token（不写死色值）', () => {
    expect(shell).toContain('className="toolbar-sep"');
    expect(lastRuleBody('.toolbar-sep')).toMatch(/background:\s*var\(--border\)/);
  });

  it('三个视图开关的 title 与快捷键说明原样保留', () => {
    for (const t of ['切换主侧栏 (Ctrl+B)', '切换底部区 (Ctrl+J)', '切换副侧栏 (Ctrl+Alt+B)']) {
      expect(shell).toContain(`title="${t}"`);
    }
  });
});

describe('⑤ 编辑器工具条 = 项目相对路径 + 视图控制右移', () => {
  it('绝对长前缀 `.file-dir` 不上屏（屏幕只留「最深目录 / 文件名」）', () => {
    expect(lastRuleBody('.editor-toolbar .file-label .file-dir')).toMatch(/display:\s*none/);
  });

  it('目录与文件名之间补可见「/」分隔（旧版两段裸挨，实测读出「靈夢 靈夢 …」歧义）', () => {
    expect(lastRuleBody(".editor-toolbar .file-label .file-pkg::after")).toMatch(/content:\s*'/);
  });

  it('完整绝对路径恒在 title（EditorPane 那侧 title={filePath} 零改动——本批禁碰该文件）', () => {
    expect(read('../src/ui/EditorPane.tsx')).toContain('<span className="file-label" title={filePath}>');
  });

  it('`.kojo 预览` 开关与糖摘要越过 spacer 进右区（flex order），编码·行数读数与保存键仍在行右', () => {
    expect(lastRuleBody('.editor-toolbar > .sugar-toggle,\n.editor-toolbar > .sugar-stats')).toMatch(/order:\s*1/);
    expect(lastRuleBody('.editor-toolbar > .editor-status')).toMatch(/order:\s*2/);
    expect(lastRuleBody('.editor-toolbar > .primary')).toMatch(/order:\s*3/);
  });
});

describe('分档等价闸不破（styles-split 的镜像纪律）', () => {
  it('C-1a 全部是**追加**：轻档一行没改、重档既有行没就地改', () => {
    const light = read('../src/styles.css');
    const heavy = css.split('\n');
    // 轻档每一条非空行仍须按序在重档中找到（与 equivalence 闸 A 同判据的轻量镜像）
    let j = -1;
    for (const line of light.split('\n')) {
      if (line.trim() === '') continue;
      j = heavy.indexOf(line, j + 1);
      expect(j >= 0 ? null : `轻档行在重档中失配：${JSON.stringify(line.slice(0, 80))}`).toBeNull();
    }
  });
});
