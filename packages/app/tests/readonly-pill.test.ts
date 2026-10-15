/**
 * 只读面与预览入口的**静态守门**（2026-10-14 只读面去重 + 预览摘出封存）。
 *
 * 为什么这几条只能这样查：`EditorPane` / `ShellLayout` 都挂着 Monaco 与整套内核槽位，
 * 在 node 里渲染不出来（本仓的渲染型测试只到模态那一层，见 sugar-dialogs.test.ts）。
 * 而这几条规矩本身就是**结构**约定——"全站只剩一颗只读胶囊""区域判定只有一份"
 * "预览入口不再被总闸收起"——运行期没有可观测面，少一把尺子下一批就会漂回去
 * （同款先例：layout.test.ts 的「持久化归属红线」）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const rel = (abs: string): string => path.relative(SRC, abs).replaceAll('\\', '/');

function read(file: string): string {
  return readFileSync(path.join(SRC, file), 'utf8');
}

/** src 下全部 .ts / .tsx（含组件与样式无关文件） */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(SRC);
  return out.sort();
}

const allFiles = sourceFiles();
const editor = read('ui/EditorPane.tsx');
const shell = read('ui/ShellLayout.tsx');
const projectView = read('ui/ProjectView.tsx');
const sugarView = read('ui/sugar-view.ts');

/* ---------------- ④ 只读指示只剩一颗 ---------------- */

describe('只读指示去重：状态栏那颗是唯一的胶囊', () => {
  it('编辑器工具条里不再有第二颗 `.sb-writable`（面包屑徽章已删）', () => {
    expect(editor).not.toContain('sb-writable');
  });

  it('全 src 只有 ShellLayout 渲染这颗胶囊（真源唯一，别处不许另造同色件）', () => {
    // 探针带上左引号 = 只认**类名字面量**（`"sb-writable…`），文档里提一句配色不算"再挂一颗"。
    const hits = allFiles.filter((f) => readFileSync(f, 'utf8').includes('"sb-writable')).map(rel);
    expect(hits).toEqual(['ui/ShellLayout.tsx']);
  });

  it('ShellLayout 内部也只各写一次：绿胶囊一处、黄胶囊一处（三态靠判定分派，不靠复制 JSX）', () => {
    expect(shell.match(/sb-writable ok/g)).toHaveLength(1);
    expect(shell.match(/sb-writable ro/g)).toHaveLength(1);
  });

  it('区域化胶囊确实吃那两个纯判定（不是就地又写一遍路径比较）', () => {
    expect(shell).toContain('fileWritableArea(kernel, activeFile');
    expect(shell).toContain('writablePillTone(');
    expect(shell).toContain("writablePill === 'ok'");
  });

  it('活动文件路径由 ProjectView 一路传进壳层（区域真源在文件所在处，不在胶囊里猜）', () => {
    expect(projectView).toContain('activeFile={activeFile}');
  });
});

/* ---------------- 区域判定只有一份 ---------------- */

describe('工作区/口上区判定：单一口径（FT-2 / PITFALLS 42 的双副本教训）', () => {
  it('调用 isUnderAnyRoot 的文件只有定义处与登记过的调用方', () => {
    // 登记表 = 这条约定的**本体**：加一个新调用方是允许的（判定仍只有一份），
    // 就地再写一遍 `roots.some(...)` 才是它要拦的那件事。
    //   ui/file-area.ts    —— 只读胶囊的区域判定（ad4e9b5）
    //   ui/search-scope.ts —— 检索范围收窄：判"范围落不落得进现有检索根"（C3，1016）
    const hits = allFiles
      .filter((f) => readFileSync(f, 'utf8').includes('isUnderAnyRoot('))
      .map(rel)
      .filter((f) => f !== 'ui/workspace-roots.ts');
    expect(hits).toEqual(['ui/file-area.ts', 'ui/search-scope.ts']);
  });

  it('EditorPane 的 inWorkspace 只是转调共享判定，不含路径比较细节', () => {
    const line = editor.split('\n').find((l) => l.includes('const inWorkspace ='));
    expect(line).toBeDefined();
    expect(line).toContain('isInWorkspaceFile(kernel, p)');
    expect(line).not.toContain('isUnderAnyRoot');
    expect(editor).not.toContain('workspace-roots');
  });
});

/* ---------------- ①② 预览默认关 + 摘出封存 ---------------- */

describe('.kojo 预览的入口不再被封存总闸收起', () => {
  it('可用门的输入表里没有 sealed（只剩三道轴）', () => {
    const gate = sugarView.match(/export function sugarViewAllowed\(input: \{([\s\S]*?)\}\)/);
    expect(gate, 'sugarViewAllowed 的签名形态变了，守门要跟着重写').not.toBeNull();
    expect(gate![1]).not.toContain('sealed');
    for (const key of ['isErbLike', 'inWorkspace', 'unlocked']) expect(gate![1]).toContain(key);
  });

  it('sugar-view.ts 的函数体里没有任何封存否决', () => {
    const body = sugarView.slice(sugarView.indexOf('export function sugarViewAllowed'));
    expect(body).not.toMatch(/if \(input\.sealed\)/);
  });

  it('三处入口都没有再传 sealed（同一谓词，口径不许分叉）', () => {
    expect(editor.match(/sugarViewAllowed\(\{/g)).toHaveLength(2); // 自动应用 + 首次询问（按钮是渲染门）
    for (const call of editor.match(/sugarViewAllowed\(\{[\s\S]*?\}\)/g) ?? []) {
      expect(call).not.toContain('sealed');
    }
    expect(editor).not.toMatch(/!sealed/);
  });

  it('命令与快捷键恒在注册表（ProjectView 不再读总闸）', () => {
    expect(projectView).toContain("id: 'workbench.toggleSugarView'");
    expect(projectView).toContain("keybinding: 'ctrl+alt+t'");
    expect(projectView).not.toContain('useSealed');
  });

  it('设置页：封存提示不再把预览说成封存件，且「编辑器」那一组不随总闸收起', () => {
    const hintLine = shell.split('\n').find((l) => l.includes('归档浏览器：'));
    expect(hintLine).toBeDefined();
    expect(hintLine).not.toContain('预览');
    const editorGroupStart = shell.indexOf('settings-group-title">编辑器');
    expect(editorGroupStart).toBeGreaterThan(-1);
    const applyCall = shell.indexOf('applySugarViewPref(e.target.checked)', editorGroupStart);
    expect(applyCall).toBeGreaterThan(-1);
    expect(shell.slice(editorGroupStart, applyCall)).not.toContain('!sealed');
  });
});

/* ---------------- ③ 按钮打磨 ---------------- */

describe('预览按钮：单色图标 + 恒字标签', () => {
  it('按钮内容 = 注册表里真实存在的图标 + 恒定标签（不是三元换字）', () => {
    expect(editor).toMatch(/<Icon name="preview" size=\{13\} \/> \.kojo 预览\s*<\/button>/);
  });

  it('`preview` 确实在图标注册表里（不凭空造名字）', () => {
    expect(read('ui/icons.tsx')).toMatch(/\n {2}preview: \(/);
  });

  it('开关态交给 class 与 aria-pressed，标签不参与状态表达（防工具条横抖）', () => {
    expect(editor).toContain('className={`ghost small sugar-toggle${sugarView ? \' on\' : \'\'}`}');
    expect(editor).toContain('aria-pressed={sugarView}');
  });
});
