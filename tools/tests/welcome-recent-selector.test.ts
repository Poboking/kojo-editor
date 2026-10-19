/**
 * SMOKE-RECENT 防再腐源形状守卫（2026-10-20）——钉死两件事：
 *
 * ① **WelcomeView 改了类名 ⇒ 本测试红**：page-object (`smoke-lib.WELCOME_RECENT_CLASSES`)
 *    所依赖的三个**独立类名 token**（`welcome-recent` / `welcome-recent-open` /
 *    `welcome-recent-path`）必须仍以**完整 token** 形态出现在 `packages/app/src/ui/WelcomeView.tsx`
 *    的 `className` 属性里。**token 级**匹配（按空白切分）而不是子串——
 *    `welcome-recent` 若被改名成 `welcome-projects`，即便 `welcome-recent-list` /
 *    `welcome-recent-open` 这类同前缀 token 仍在，token 集合里 `welcome-recent` 独立一格就消失 ⇒ 红。
 *
 * ② **工具里再出现旧选段 ⇒ 本测试红**：`.recent button.link` / `.recent-dir` 这两个死掉的
 *    选择段串在 `tools/` 下**零处出现**（本守卫文件 `tools/tests/` 除外；它按 kojo 惯例
 *    "守卫自己住在 tests/，扫 tools/ 天然不含它"）。
 *
 * 附加记账（house style：`kojo-extension-single-source.test.ts` 的"出现次数本身就是记账项"）：
 * 类名字符串**只准住在 `smoke-lib.mjs`**——五个消费方（四个真壳冒烟 + `ui-measure`）
 * 不许在 querySelectorAll 字符串里手抄任何一个类名。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WELCOME_RECENT_CLASSES,
  recentOpenRowSel,
  recentRowClickSrc,
  recentRowFinderSrc,
  recentRowWaitSrc,
} from '../smoke-lib.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/* ─── ① WelcomeView 类名 ⇔ page-object（token 级匹配，防前缀假绿） ─── */

const welcomeSrc = readFileSync(
  path.join(ROOT, 'packages', 'app', 'src', 'ui', 'WelcomeView.tsx'),
  'utf8',
);

/**
 * 抽出所有 `className` 属性值里的**独立类名 token**（空白切）。
 * 覆盖三种 JSX 常见形态：
 *   className="a b c"                       普通字符串
 *   className={`a ${x ? ' b' : ''}`}        模板字面（剥掉 `${...}` 再切）
 *   className={'a'} / className={"a"}       表达式包字符串
 */
function extractClassTokens(src: string): Set<string> {
  const tokens = new Set<string>();
  const addChunk = (raw: string) => {
    for (const t of raw.replace(/\$\{[^}]*\}/g, ' ').trim().split(/\s+/)) {
      if (t) tokens.add(t);
    }
  };
  for (const m of src.matchAll(/className="([^"]*)"/g)) addChunk(m[1]!);
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) addChunk(m[1]!);
  for (const m of src.matchAll(/className=\{'([^']*)'\}/g)) addChunk(m[1]!);
  for (const m of src.matchAll(/className=\{"([^"]*)"\}/g)) addChunk(m[1]!);
  return tokens;
}

const WELCOME_TOKENS = extractClassTokens(welcomeSrc);

/** page-object 用到的每个类名都必须以独立 token 形态在渲染面出现——改一个 ⇒ 红 */
const PAGE_OBJECT_CLASSES = [
  { key: 'section', cls: WELCOME_RECENT_CLASSES.section },
  { key: 'open', cls: WELCOME_RECENT_CLASSES.open },
  { key: 'path', cls: WELCOME_RECENT_CLASSES.path },
] as const;

describe('SMOKE-RECENT ① WelcomeView 类名 token ⇔ smoke-lib page-object', () => {
  it('选择器串钉死为 `.welcome-recent .welcome-recent-open`（类名改 ⇒ 串变 ⇒ 红）', () => {
    expect(recentOpenRowSel).toBe('.welcome-recent .welcome-recent-open');
  });

  it.each(PAGE_OBJECT_CLASSES)('page-object 依赖的类名仍是 WelcomeView 里的独立 token：$cls', ({ cls }) => {
    expect(
      WELCOME_TOKENS.has(cls),
      `WelcomeView.tsx 里已找不到独立类名 token "${cls}"；page-object 会静默挂（真壳 a–e 前置崩）`,
    ).toBe(true);
  });

  it('三条源码函数生成的 JS 都指回同一个 recentOpenRowSel（选择段只此一处）', () => {
    const dirJson = JSON.stringify('C:\\game\\x');
    for (const src of [
      recentRowFinderSrc(dirJson),
      recentRowWaitSrc(dirJson),
      recentRowClickSrc(dirJson),
    ]) {
      expect(src).toContain(`"${recentOpenRowSel}"`);
      expect(src).toContain(`".${WELCOME_RECENT_CLASSES.path}"`);
    }
  });

  it('结构：section 在 path/open 之前（JSX 书写顺序即 DOM 嵌套顺序）', () => {
    // 钉住 WelcomeView 里三个类名各出现一次在正确嵌套层——不是任意三行
    const idxOf = (needle: string) => welcomeSrc.indexOf(needle);
    const sectionAt = idxOf(`className="welcome-section ${WELCOME_RECENT_CLASSES.section}"`);
    const openAt = idxOf(`className="${WELCOME_RECENT_CLASSES.open}"`);
    const pathAt = idxOf(`className="${WELCOME_RECENT_CLASSES.path}"`);
    expect(sectionAt, 'section 属性行').toBeGreaterThanOrEqual(0);
    expect(openAt, 'open 属性行').toBeGreaterThan(sectionAt);
    expect(pathAt, 'path 属性行').toBeGreaterThan(openAt);
  });
});

/* ─── ② 全仓守门：旧选段与手抄类名在 tools/ 下零处复现 ─── */

/**
 * 两条死掉的选择段串。用 `+` 拆开写，防止本守卫文件自己含这两串——
 * 否则扫描时假阳（守卫文件本身就在 tools/tests/ 下）。
 */
const DEAD_SELECTOR_1 = '.recent' + ' button.link';
const DEAD_SELECTOR_2 = '.recent' + '-dir';
const DEAD_SELECTORS: ReadonlyArray<{ readonly needle: string; readonly why: string }> = [
  { needle: DEAD_SELECTOR_1, why: '旧版欢迎页最近项目行的可点按钮（`.recent button.link`）' },
  { needle: DEAD_SELECTOR_2, why: '旧版路径文本 span（`.recent-dir`）' },
];

/**
 * tools/ 下所有**运行时源**文件（`*.mjs` / `*.cjs` / `*.js`）——不含 `tools/tests/`
 * 里的 `.ts` 守卫（本文件也住在 tests/，按 kojo 惯例排除）；不含 `scenes/` 语料子目录。
 */
function collectToolRuntimeSources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tests' || e.name === 'scenes') continue;
      collectToolRuntimeSources(abs, acc);
    } else if (/\.(mjs|cjs|js)$/.test(e.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

const TOOLS_DIR = path.join(ROOT, 'tools');
const TOOL_SOURCES = collectToolRuntimeSources(TOOLS_DIR);

describe('SMOKE-RECENT ② 全仓守门：旧选段与手抄类名在 tools/ 下各自归零', () => {
  it('扫到的工具源文件集合非空（守卫没退化成空扫描）', () => {
    // 已知 tools/ 有 ~20 个 .mjs / .cjs / .js 源文件；少于 10 说明扫描器漏读
    expect(TOOL_SOURCES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(DEAD_SELECTORS)('死选段 $why 在 tools/ 下的出现处数 = 0', ({ needle }) => {
    const offenders: string[] = [];
    for (const abs of TOOL_SOURCES) {
      const text = readFileSync(abs, 'utf8');
      if (text.includes(needle)) {
        offenders.push(path.relative(ROOT, abs).replace(/\\/g, '/'));
      }
    }
    expect(offenders, `这些 tools/ 文件仍含死选段 "${needle}"`).toEqual([]);
  });

  it('四个真壳冒烟 + ui-measure 都经由 smoke-lib page-object（不自己抄类名）', () => {
    const CONSUMER_TOOLS = [
      'smoke-tauri-ipc.mjs',
      'smoke-tauri-market.mjs',
      'smoke-editor-features.mjs',
      'boot-watermarks.mjs',
      'ui-measure.mjs',
    ];
    for (const name of CONSUMER_TOOLS) {
      const abs = path.join(TOOLS_DIR, name);
      expect(statSync(abs).isFile(), `${name} 应在`);
      const text = readFileSync(abs, 'utf8');
      // 消费方源码里不出现这三个类名字符串（它们只准住在 smoke-lib 一处）
      for (const cls of Object.values(WELCOME_RECENT_CLASSES)) {
        expect(text.includes(cls), `${name} 不应再手抄类名 "${cls}"`).toBe(false);
      }
      // 消费方源码必须 import smoke-lib 的 page-object
      expect(
        /from\s+['"]\.\/smoke-lib\.mjs['"]/.test(text),
        `${name} 应 import ./smoke-lib.mjs`,
      ).toBe(true);
    }
  });

  it('反向对照：类名字符串只住 smoke-lib 一处（提供方在、其他 tools/ 源文件零处手抄）', () => {
    const libAbs = path.join(TOOLS_DIR, 'smoke-lib.mjs');
    const libText = readFileSync(libAbs, 'utf8');
    for (const cls of Object.values(WELCOME_RECENT_CLASSES)) {
      expect(libText.includes(cls), `smoke-lib 应持有 "${cls}"（提供方缺席 ⇒ 消费方无处 import）`).toBe(true);
    }
    const others = TOOL_SOURCES.filter((f) => path.basename(f) !== 'smoke-lib.mjs');
    const leaks: string[] = [];
    for (const abs of others) {
      const text = readFileSync(abs, 'utf8');
      for (const cls of Object.values(WELCOME_RECENT_CLASSES)) {
        if (text.includes(cls)) leaks.push(`${path.relative(ROOT, abs).replace(/\\/g, '/')} → ${cls}`);
      }
    }
    expect(leaks, '类名只准住 smoke-lib；其他 tools/ 源文件不得手抄').toEqual([]);
  });
});
