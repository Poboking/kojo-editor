/**
 * **CTX-SMOKE 源形状守门**（2026-10-23；看板 CTX-SMOKE / 原 WP6.5 真机冒烟）。
 *
 * 真机冒烟（`tools/smoke-tauri-dom.mjs` 的 CTX-SMOKE 段 + `tools/context-menu-smoke.mjs`）在
 * 本机要 Rust 全量编译才能跑，**平时进不了 CI**。跑得少的东西必腐，所以把"腐了会静默假绿"
 * 的四件事拆成纯读源码的断言：
 *
 * ① **四组断言一个不少**：A/B/C/D 四个标记必须都在冒烟脚本里。少一组 = 那一面又回到
 *    "只有单测、真壳里没量过"；
 * ② **ariaLabel 对照表 ⇔ 清单**：`CONTEXT_MENU_ARIA_EXPECT` 是独立 node 进程里抄的一份
 *    `CONTEXT_SURFACE_MANIFEST`，改面/改 ariaLabel 时忘了同步 ⇒ B 组会拿旧名字判，
 *    屏上却按新名字渲染（真机红在一句对不上的中文名上，最难查）。这里逐条对源码，
 *    **双向**（表里的每一条在清单里且同名；面的三处清单项都在表里）；
 * ③ **选择器与实现同源**：脚本用的每个关键选择器都得在 `packages/app/src` 里真实存在
 *    ——类名/属性被重命名时，冒烟只会读到 `null` 然后判红在"菜单没出现"，而真相是
 *    "选择器过期了"；
 * ④ **失败不许降级成 warn**：四组必须走同一个判定收集器（`checks.push` 是唯一出口），
 *    脚本里不许出现 `console.warn` 版的 CTX-SMOKE 失败路径，`bytes` 也不用
 *    "catch 里把 pass 置 true" 这种方式糊过去。
 *
 * 全部纯读文件，不起壳、不渲染（DOM 重演见 `context-menu-smoke-replay.test.ts`）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_MENU_ARIA_EXPECT,
  CTX_SMOKE_GROUPS,
  CTX_SMOKE_SELECTORS,
  FALLBACK_MENU_ARIA_LABEL_EXPECT,
  HOST_Z_INDEX_MIN,
  judgeContextMenuProbes,
  runContextMenuProbes,
} from '../context-menu-smoke.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');

const SMOKE = read('tools', 'smoke-tauri-dom.mjs');
const PROBE = read('tools', 'context-menu-smoke.mjs');
const SURFACES = read('packages', 'app', 'src', 'ui', 'context-surfaces.ts');
const MODEL = read('packages', 'app', 'src', 'ui', 'context-menu-model.ts');
const MENU_CSS = read('packages', 'app', 'src', 'context-menu.css');

/* ───────────────────────── ① 四组标记一个不少 ───────────────────────── */

describe('CTX-SMOKE ① 四组断言都在冒烟脚本里', () => {
  it('组号常量就是 A/B/C/D（判定与彩排共用同一份）', () => {
    expect([...CTX_SMOKE_GROUPS]).toEqual(['A', 'B', 'C', 'D']);
  });

  it.each(['A', 'B', 'C', 'D'])('CTX-SMOKE-%s 标记在脚本里', (group) => {
    expect(SMOKE).toContain(`CTX-SMOKE-${group}`);
  });

  it('四组真的被执行（探针返回 a1/a2/b/c/d 五块读数，判定逐块消费）', () => {
    const body = runContextMenuProbes.toString();
    // 返回对象用的是简写键（`{ a1, a2, b, c, d, … }`）
    expect(body).toMatch(/a1,\s*a2,\s*b,\s*c,\s*d,/);
    for (const call of [
      'await prepareEditor()',
      'await probeMonacoNative()',
      'await probeEditorFrame()',
      'await probeHotzones()',
      'await probeBackdrop()',
      'await probeStacking()',
    ]) {
      expect(body).toContain(call);
    }
    const judge = judgeContextMenuProbes.toString();
    for (const key of ['r.a1', 'r.a2', 'r.b', 'r.c', 'r.d']) {
      expect(judge).toContain(key);
    }
  });

  it('CTX-SMOKE 的 pass 进了总闸（不然跑完照样绿）', () => {
    expect(SMOKE).toContain('checks.contextMenu.pass &&');
    expect(SMOKE).toContain('checks.contextMenu.pass = judged.pass;');
  });
});

/* ─────────────────────── ② ariaLabel 对照表 ⇔ 清单 ─────────────────────── */

interface ManifestEntry {
  readonly id: string;
  readonly ariaLabel: string;
  readonly area: string;
}

/** 解析 `{ id: '…', ariaLabel: '…', area: '…' }`（清单就是这种一行一条的字面量） */
function parseManifest(source: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const re = /\{\s*id:\s*'([^']+)',\s*ariaLabel:\s*'([^']+)',\s*area:\s*'([^']+)'\s*\}/g;
  for (const m of source.matchAll(re)) out.push({ id: m[1]!, ariaLabel: m[2]!, area: m[3]! });
  return out;
}

const MANIFEST = parseManifest(SURFACES);

describe('CTX-SMOKE ② ariaLabel 对照表与 CONTEXT_SURFACE_MANIFEST 逐条一致', () => {
  it('清单解析非空（解析器没退化成空表）', () => {
    // 清单当前 30+ 条；少于 20 说明格式变了、解析器漏读 ⇒ 后面全是真空断言
    expect(MANIFEST.length).toBeGreaterThanOrEqual(20);
  });

  it.each(Object.entries(CONTEXT_MENU_ARIA_EXPECT))(
    '面 %s 的 ariaLabel 与清单一致',
    (id, ariaLabel) => {
      const entry = MANIFEST.find((e) => e.id === id);
      expect(entry, `清单里没有面 '${id}'（冒烟表抄旧了？）`).toBeDefined();
      expect(entry?.ariaLabel, `面 '${id}' 的 ariaLabel 漂了：冒烟表=${ariaLabel}，清单=${entry?.ariaLabel}`).toBe(
        ariaLabel,
      );
    },
  );

  it('B 组要的三处热区面都在对照表里（文件树 / 标签页 / 三种面板候选）', () => {
    for (const id of ['file-tree', 'tabs', 'problems', 'search-results', 'panel-tabs']) {
      expect(Object.keys(CONTEXT_MENU_ARIA_EXPECT)).toContain(id);
    }
  });

  it('A2 的编辑器外框名与清单一致', () => {
    expect(CONTEXT_MENU_ARIA_EXPECT.editor).toBe(
      MANIFEST.find((e) => e.id === 'editor')?.ariaLabel,
    );
  });

  it('兜底名与源码常量同源（B 组「不是兜底菜单」那条判据靠它）', () => {
    expect(MODEL).toContain(`FALLBACK_MENU_ARIA_LABEL = '${FALLBACK_MENU_ARIA_LABEL_EXPECT}'`);
  });

  it('D 组的宿主 z-index 下界与 CSS 真源一致', () => {
    const block = MENU_CSS.slice(MENU_CSS.indexOf('.context-menu-host {'));
    const zIndex = Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
    expect(zIndex, `.context-menu-host 的 z-index 读不到（上下文：${block.slice(0, 120)}）`).toBe(HOST_Z_INDEX_MIN);
    expect(HOST_Z_INDEX_MIN).toBeGreaterThanOrEqual(1200); // 至少要压过提示类浮层
  });
});

/* ───────────────────── ③ 选择器与实现同源（源码里真有） ───────────────────── */

/**
 * 每个选择器 → 它依赖的**源码 token**。token 是"改了就一定得一起改"的那一小段：
 * 类名 token / 属性名 / 属性值。挂在哪个文件上写死，便于红的时候一眼定位。
 */
const SELECTOR_SOURCES: ReadonlyArray<{
  readonly key: keyof typeof CTX_SMOKE_SELECTORS;
  readonly file: readonly string[];
  readonly token: string;
  readonly why: string;
}> = [
  {
    key: 'host',
    file: ['packages', 'app', 'src', 'ui', 'context-menu-host.tsx'],
    token: 'className="context-menu-host"',
    why: '根宿主元素的类名（D 组量层叠的锚）',
  },
  {
    key: 'menu',
    file: ['packages', 'app', 'src', 'ui', 'context-menu.tsx'],
    token: 'context-menu context-menu--shared',
    why: '菜单面板的类名（A2/B 读 aria-label 的锚）',
  },
  {
    key: 'backdrop',
    file: ['packages', 'app', 'src', 'ui', 'context-menu.tsx'],
    token: 'className="context-menu-backdrop"',
    why: '遮罩（C 组派发 mousedown 的锚）',
  },
  {
    key: 'menuitem',
    file: ['packages', 'app', 'src', 'ui', 'context-menu.tsx'],
    token: 'role="menuitem"',
    why: '菜单项的角色（A/B 数菜单项用）',
  },
  {
    key: 'editorFrame',
    file: ['packages', 'app', 'src', 'ui', 'EditorPane.tsx'],
    token: 'data-context-surface="editor"',
    why: '编辑器外框面（A2 的右键目标）',
  },
  {
    key: 'monaco',
    file: ['packages', 'app', 'src', 'ui', 'App.tsx'],
    token: "closest('.monaco-editor')",
    why: '根路由对 Monaco 整片放行的判据（A1 的右键目标由它划界）',
  },
  {
    key: 'monacoMenu',
    file: ['packages', 'app', 'src', 'context-menu.css'],
    token: 'monaco-menu-container',
    why: 'Monaco 原生菜单的容器类（A1 认它，别写成我们的 .context-menu）',
  },
  {
    key: 'floatingPanel',
    file: ['packages', 'app', 'src', 'styles-project.css'],
    token: '.floating-panel',
    why: 'D 组要压过的浮层',
  },
  {
    key: 'fileTreeRow',
    file: ['packages', 'app', 'src', 'ui', 'file-tree-row.tsx'],
    token: 'data-context-surface="file-tree"',
    why: '文件树行的面根（B 组第一处热区）',
  },
  {
    key: 'tabRow',
    file: ['packages', 'app', 'src', 'ui', 'tab-row.tsx'],
    token: 'data-context-surface="tabs"',
    why: '标签行的面根（B 组第二处热区）',
  },
  {
    key: 'statusCell',
    file: ['packages', 'app', 'src', 'ui', 'PanelHost.tsx'],
    token: 'data-status-cell',
    why: '状态栏格的显式标记（本批新选择器，别按类名猜）',
  },
];

describe('CTX-SMOKE ③ 脚本用的选择器在 packages/app/src 里真实存在', () => {
  it.each(SELECTOR_SOURCES)('$key ← $token（$why）', ({ file, token }) => {
    expect(read(...file)).toContain(token);
  });

  it('选择器常量没有指向不存在的键（表格与常量双向齐全）', () => {
    const keys = Object.keys(CTX_SMOKE_SELECTORS).sort();
    const covered = SELECTOR_SOURCES.map((s) => String(s.key)).sort();
    expect(covered).toEqual(keys);
  });

  it('探针里真的是这些字面量（表格不是摆设：表改了、探针没改 ⇒ 红）', () => {
    const body = runContextMenuProbes.toString();
    for (const [key, sel] of Object.entries(CTX_SMOKE_SELECTORS)) {
      expect(body, `选择器表里的 ${key}=${sel} 在页内探针里找不到字面量`).toContain(sel);
    }
  });

  it('标签行的选择器同时要求 role="tab" 与面属性（tab-row.tsx 两样都在）', () => {
    const row = read('packages', 'app', 'src', 'ui', 'tab-row.tsx');
    expect(row).toContain('role="tab"');
    expect(row).toContain('data-context-surface="tabs"');
    expect(CTX_SMOKE_SELECTORS.tabRow).toBe('[role="tab"][data-context-surface="tabs"]');
  });
});

/* ───────────── ④ 四组走同一个判定收集器，失败不许降级成 warn ───────────── */

describe('CTX-SMOKE ④ 判定收集器唯一、失败不降级', () => {
  it('judge 里只有一个失败出口（checks.push 只出现一次）', () => {
    const hits = PROBE.split('checks.push(').length - 1;
    expect(hits, '`checks.push(` 必须只出现在唯一的收集器里；多一处 = 有一条判据绕过了它').toBe(1);
  });

  it('收集器的签名带 group（四组结果可归因）', () => {
    expect(PROBE).toContain('const push = (group, name, ok, detail, skipped)');
  });

  it('判定函数里没有任何 console 通道（失败只登记，不打印了当没事）', () => {
    const body = judgeContextMenuProbes.toString();
    expect(body).not.toMatch(/console\.(warn|error|log)/);
  });

  it('冒烟脚本里 CTX-SMOKE 的失败不走 console.warn（只走逐条打印 + 总闸）', () => {
    expect(SMOKE).not.toMatch(/console\.warn\([^)]*CTX-SMOKE/);
    expect(SMOKE).not.toMatch(/console\.warn\([^)]*contextMenu/);
  });

  it('采集失败不会把 pass 置真（catch 里只记 reason）', () => {
    const at = SMOKE.indexOf('CTX-SMOKE 采集失败');
    expect(at).toBeGreaterThan(-1);
    const tail = SMOKE.slice(at, at + 400);
    expect(tail).not.toContain('contextMenu.pass = true');
    expect(tail).toContain('contextMenu.reason');
  });

  it('A 组没有跳过档（没有编辑区就判红）', () => {
    const judge = judgeContextMenuProbes.toString();
    const aStart = judge.indexOf("push('A'");
    const bStart = judge.indexOf('/* ---- B：三处热区 ---- */');
    expect(aStart).toBeGreaterThan(-1);
    expect(bStart).toBeGreaterThan(aStart);
    const aBlock = judge.slice(aStart, bStart);
    expect(aBlock).not.toContain('skipped');
    expect(aBlock).toContain('没有 .monaco-editor');
  });

  it('B 组的跳过只发生在"热区不在场"，且带原因', () => {
    const judge = judgeContextMenuProbes.toString();
    const bStart = judge.indexOf('/* ---- B：三处热区 ---- */');
    const cStart = judge.indexOf('/* ---- C：遮罩只认左键 ---- */');
    const bBlock = judge.slice(bStart, cStart);
    const skipLines = bBlock.split('\n').filter((line) => line.includes('true,') && line.includes('跳过'));
    expect(skipLines.length).toBeGreaterThan(0);
    expect(bBlock).toContain('zone.applicable !== true');
  });

  it('页内探针自包含（只能靠 toString 序列化，引用模块级常量会在真机上变成 undefined）', () => {
    const body = runContextMenuProbes.toString();
    for (const name of ['CONTEXT_MENU_ARIA_EXPECT', 'CTX_SMOKE_SELECTORS', 'HOST_Z_INDEX_MIN', 'judgeContextMenuProbes']) {
      expect(body, `页内探针引用了模块级标识符 ${name}：序列化后取不到值`).not.toContain(name);
    }
    expect(body).toContain('opts.recentRowSel');
  });

  it('序列化后的探针是合法 JS（TS 语法/可选链泄漏进页内函数会在真机上直接抛）', () => {
    const src = `(${runContextMenuProbes.toString()})`;
    expect(() => new Function(`return ${src}`)).not.toThrow();
  });

  it('页内探针只采集、不下断言（判定全在 judge 里）', () => {
    const body = runContextMenuProbes.toString();
    expect(body).not.toContain('pass:');
    expect(body).not.toContain('throw new Error');
  });
});
