/**
 * 图标名 ↔ 注册表闭合闸（1027 批 · 全仓面）。
 *
 * ## 起因
 * 插件面板右键三条「复制」项写的是 `icon: 'copy'`，而注册表里没有这枚。`Icon` 的未命中
 * 回退（`icons.tsx` 里那条「按字形文本渲染」的第三方兼容口径）于是把英文单词 `copy`
 * 原样印在菜单上——**第三方的单字字形是契约，宿主自己的漏册是缺陷**，两者不该共用一条回落。
 * 补一枚图标只是一次修；这一闸才是让下一枚漏册不可能再溜的东西。
 *
 * ## 射程
 * 全仓 `.ts` / `.tsx` **源码**（跳 `node_modules` / `dist` / `out` / `target` / `build` /
 * `coverage` / `.git`；`.d.ts` 是声明面，不产调用）。测试文件按本仓既有豁免口径不进：
 * `icons-system.test.ts` 要拿 `＋`、`ui-kit.test.ts` 拿 `◎`、`layout.test.ts` 拿 `🗀` /
 * `download` 这类假名钉「未命中回退」的行为本身，让它们对册等于把闸做成瞎闸。
 *
 * ## 认三种写法（其余形态拿不到静态名，不在射程）
 *   ① `icon: 'x'`——含联合 `icon?: 'a' | 'b'` 与三元 `icon: ok ? 'a' : 'b'` 的每个字面成员；
 *   ② `<Icon name="x" />`；
 *   ③ `<Icon name={ok ? 'a' : 'b'} />`（花括号内的字面成员同样算）。
 * `icon: item.icon`、`name={SEVERITY_ICON[sev]}` 这类标识符/下标取值不产生命中。
 * **注释与字符串字面量里的同形文本不算调用**：先剥注释（等长刷白、行号不动）、再按字符串
 * 区间屏蔽命中点（`ui-kit/index.tsx` 文档注释里那句 ``<Icon name="…" />`` 就是这条口径的成因）。
 *
 * ## 判据形态
 * 照 `icons-system.test.ts` 的「名 ↔ 注册表闭合闸」：读源码、逐个名字对册，判红点名
 * `文件:行号 · '名字'（形态）`。「闸自证」段把不存在的名字喂进**同一套抽取器**验必红、
 * 把同形噪声喂进去验不红——真实树扫描与合成片段走同一条代码路径，杜绝两套尺。
 */
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ICONS } from '../src/ui/icons';

const registry = new Set(Object.keys(ICONS));
/** `packages/app/tests/` 上溯三级 = 仓库根（以它为锚，与 `--config` 的调用目录无关） */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'target', 'build', 'coverage', '.git']);

/** 判据里的路径一律正斜杠归一：Windows 上不许出现两份口径 */
const norm = (p: string): string => p.split(path.sep).join('/');

interface Hit {
  name: string;
  /** 命中点在「剥注释后源码」里的下标（行号据此算） */
  index: number;
  form: 'icon:' | '<Icon name="…">' | '<Icon name={…}>';
}

interface Scan {
  rel: string;
  /** 剥掉注释后的源码（行号与原文一致） */
  code: string;
  hits: Hit[];
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listSourceFiles(full, out);
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 既有豁免口径：测试文件不进闸（它们要拿假名钉回退行为本身） */
function isTestFile(rel: string): boolean {
  return /(^|\/)tests?\//.test(rel) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(rel);
}

/**
 * 把注释等长刷白（行号、下标全部保持原位），并记录字符串字面量区间 `[start, end)`。
 * 词法级粗判够用：三种引号 + 反斜杠转义，不做完整 TS 解析。`'` / `"` 遇换行即当作未闭合
 * 收口——真串字面量不许跨行，这条只防「正则字面量里的引号」（如 `/[\'"]/` 那种）把后面的
 * 真命中整段吞成假阴性。
 */
function prepare(raw: string): { code: string; spans: Array<[number, number]> } {
  const chars = raw.split('');
  const spans: Array<[number, number]> = [];
  let quote: "'" | '"' | '`' | null = null;
  let quoteStart = -1;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < chars.length; k += 1) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
  };
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (quote !== null) {
      if (ch === '\\') i += 2;
      else {
        const unterminated = ch === '\n' && quote !== '`';
        if (ch === quote || unterminated) {
          spans.push([quoteStart, i]);
          quote = null;
          quoteStart = -1;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = raw.indexOf('\n', i);
      const to = end === -1 ? raw.length : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = raw.indexOf('*/', i + 2);
      const to = end === -1 ? raw.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      quoteStart = i;
    }
    i += 1;
  }
  if (quoteStart !== -1) spans.push([quoteStart, raw.length]);
  return { code: chars.join(''), spans };
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) if (code[i] === '\n') line += 1;
  return line;
}

const quotedLiteral = (): RegExp => /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
const inSpan = (spans: Array<[number, number]>, index: number): boolean =>
  spans.some(([start, end]) => index >= start && index < end);

/** `icon:` 之后的取值片段：深度 0 遇 `,` `;` `}` `)` `]` 收口，字符串整段跳过 */
function valueText(code: string, spans: Array<[number, number]>, from: number): string {
  let depth = 0;
  let i = from;
  while (i < code.length) {
    const span = spans.find(([start, end]) => i >= start && i < end);
    if (span !== undefined) {
      i = span[1];
      continue;
    }
    const ch = code[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if ((ch === ',' || ch === ';') && depth === 0) break;
    i += 1;
  }
  return code.slice(from, i);
}

/** 片段里的每个字面量，连同它在原码里的下标 */
function literalsOf(fragment: string, fragmentStart: number): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = quotedLiteral();
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out.push({ text: m[2]!, index: fragmentStart + m.index });
  return out;
}

/** 抽取一份源码里全部「字面图标名」命中点（真实树与合成片段共用这一条实现） */
function collect(rel: string, raw: string): Scan {
  const { code, spans } = prepare(raw);
  const hits: Hit[] = [];

  /* ① `icon: 'x'` / `icon?: 'a' | 'b'` / `icon: ok ? 'a' : 'b'` */
  const keyRe = /\bicon\??\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(code)) !== null) {
    if (inSpan(spans, m.index)) continue;
    const from = m.index + m[0].length;
    const value = valueText(code, spans, from);
    if (value.trimStart().startsWith('<')) continue; // 取值是 JSX：名在 <Icon …> 那一跳里认
    for (const lit of literalsOf(value, from)) {
      if (lit.text.length === 0) continue; // 空串＝不给图标，不是一个名字
      hits.push({ name: lit.text, index: lit.index, form: 'icon:' });
    }
  }

  /* ② / ③ `<Icon name="x" />` 与 `<Icon name={…} />` */
  const tagRe = /<Icon\b[^>]*/g;
  while ((m = tagRe.exec(code)) !== null) {
    if (inSpan(spans, m.index)) continue;
    const tag = m[0];
    const attr = /\bname\s*=\s*/.exec(tag);
    if (attr === null) continue;
    const valueStart = m.index + attr.index + attr[0].length;
    const rest = tag.slice(attr.index + attr[0].length);
    const quoted = /^\s*(['"`])(?:\\.|(?!\1)[\s\S])*?\1/.exec(rest);
    if (quoted !== null) {
      const inner = quotedLiteral().exec(rest);
      if (inner !== null && inner[2]!.length > 0) hits.push({ name: inner[2]!, index: valueStart, form: '<Icon name="…">' });
      continue;
    }
    const braced = /^\s*\{([^{}]*)\}/.exec(rest);
    if (braced !== null) {
      const exprStart = valueStart + braced[0].indexOf(braced[1]!);
      for (const lit of literalsOf(braced[1]!, exprStart)) {
        if (lit.text.length === 0) continue;
        hits.push({ name: lit.text, index: lit.index, form: '<Icon name={…}>' });
      }
    }
  }
  return { rel, code, hits: hits.sort((a, b) => a.index - b.index) };
}

const formatHit = (scan: Scan, hit: Hit): string =>
  `${scan.rel}:${lineOf(scan.code, hit.index)} · '${hit.name}'（${hit.form}）`;

/* —— 真实树扫描（一次读盘，几条判据复用同一份结果） —— */
const tree: Scan[] = [];
for (const abs of listSourceFiles(repoRoot)) {
  const rel = norm(path.relative(repoRoot, abs));
  if (isTestFile(rel)) continue;
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  tree.push(collect(rel, raw));
}
const hitCount = tree.reduce((n, scan) => n + scan.hits.length, 0);
const offenders = tree.flatMap((scan) =>
  scan.hits.filter((hit) => !registry.has(hit.name)).map((hit) => ({ line: formatHit(scan, hit), form: hit.form })),
);
const offendersOf = (...forms: Hit['form'][]): string[] =>
  offenders.filter((o) => forms.includes(o.form)).map((o) => o.line);

describe('图标注册表闭合闸 · 全仓字面名对册', () => {
  it('扫得到源码、认得出名字（闸不是空跑）', () => {
    expect(tree.length, '全仓源码（非测试）文件数').toBeGreaterThan(600);
    expect(hitCount, '全仓字面图标名命中处数（只涨不跌：抽取器退化就先红这里）').toBeGreaterThan(250);
    const hitNames = new Set(tree.flatMap((scan) => scan.hits.map((hit) => hit.name)));
    for (const known of ['copy', 'refresh', 'close', 'chevron-right', 'preview']) {
      expect(hitNames.has(known), `抽取器应在真实树上认出 '${known}'`).toBe(true);
    }
    expect(tree.some((scan) => scan.hits.some((hit) => hit.form.startsWith('<Icon'))), '真实树上确有 <Icon name=…> 命中').toBe(true);
    // 三条判据按形态分头报——新形态若忘了归队，这里先红，不许让漏册悄悄掉出报告
    expect(
      offendersOf('icon:', '<Icon name="…">', '<Icon name={…}>'),
      '每条漏册都必须归进某一种认得的形态',
    ).toHaveLength(offenders.length);
  });

  it('每个 `icon:` 字面名都在 ICONS 注册表（判红点名 文件:行号）', () => {
    const lines = offendersOf('icon:');
    expect(lines, `这些 \`icon:\` 字面名不在注册表里，界面上会原样印成英文单词:\n${lines.join('\n')}`).toEqual([]);
  });

  it('每个 `<Icon name=…>` 字面名都在册（含 `name={cond ? 这一枚 : 那一枚}`）', () => {
    const lines = offendersOf('<Icon name="…">', '<Icon name={…}>');
    expect(lines, `这些 <Icon name=…> 字面名不在注册表里:\n${lines.join('\n')}`).toEqual([]);
  });

  it('中招点复在：插件面板右键三条「复制」用的就是 copy，且它现在在册', () => {
    const scan = tree.find((s) => s.rel.endsWith('ui/plugin-panel-menu.ts'));
    expect(scan, 'plugin-panel-menu.ts 在扫描射程内').toBeDefined();
    expect(scan?.hits.map((hit) => hit.name)).toEqual(['copy', 'copy', 'copy']);
    expect(registry.has('copy'), 'copy 必须进 ICONS——IconName = keyof typeof ICONS，联合类型随之而得，不留 string 逃逸口').toBe(true);
  });
});

describe('闸自证 · 变异必须抓得到，同形噪声必须不抓', () => {
  it('变异正例：`icon:` 写一枚不存在的名字 ⇒ 抓得到、定到位、且确实不在册', () => {
    const raw = "const item = {\n  id: 'x',\n  icon: 'no-such-icon',\n};\n";
    const scan = collect('mutant-a.ts', raw);
    expect(scan.hits.map((hit) => hit.name)).toEqual(['no-such-icon']);
    expect(formatHit(scan, scan.hits[0]!)).toBe("mutant-a.ts:3 · 'no-such-icon'（icon:）");
    expect(registry.has('no-such-icon')).toBe(false);
    // 同一枚名字换成在册的 `preview`，闸就该闭嘴
    expect(collect('mutant-b.ts', raw.replace('no-such-icon', 'preview')).hits.map((hit) => hit.name)).toEqual(['preview']);
  });

  it('变异正例：联合类型与三元的每个字面成员都算', () => {
    const raw =
      "interface T {\n  readonly icon?: 'book' | 'ghost-one' | 'code';\n}\nconst build = (ok: boolean) => ({ icon: ok ? 'refresh' : 'ghost-two' });\n";
    const scan = collect('mutant-union.tsx', raw);
    expect(scan.hits.map((hit) => hit.name)).toEqual(['book', 'ghost-one', 'code', 'refresh', 'ghost-two']);
    expect(lineOf(scan.code, scan.hits[1]!.index)).toBe(2);
    expect(lineOf(scan.code, scan.hits[4]!.index)).toBe(4);
  });

  it('变异正例：`<Icon name="ghost" />` 与 `name={ok ? 在册 : 漏册}` 都抓得到', () => {
    const raw = 'export const A = () => <Icon name="ghost-a" size="sm" />;\nexport const B = (ok: boolean) => (\n  <Icon\n    name={ok ? \'check\' : "ghost-b"}\n  />\n);\n';
    const scan = collect('mutant-jsx.tsx', raw);
    expect(scan.hits.map((hit) => hit.name)).toEqual(['ghost-a', 'check', 'ghost-b']);
    expect(scan.hits[0]!.form).toBe('<Icon name="…">');
    expect(scan.hits[2]!.form).toBe('<Icon name={…}>');
  });

  it('反例：注释里的同形文本不算调用（文档注释写了 ghost 也不红）', () => {
    const raw = "/** 用法：icon: 'ghost-a' 或 <Icon name=\"ghost-b\" /> */\n// icon: 'ghost-c'\nexport const x = 1;\n";
    expect(collect('noise-comment.ts', raw).hits).toEqual([]);
  });

  it('反例：字符串里的同形文本不算调用；标识符/下标取值不产生命中', () => {
    const raw =
      "const hint = '别把 icon: 写成 ghost-a';\nconst a = { icon: item.icon };\nconst b = <Icon name={SEVERITY_ICON[sev]} />;\nconst c = { icon: IconNameUnion };\n";
    expect(collect('noise-ident.tsx', raw).hits.map((hit) => hit.name)).toEqual([]);
  });

  it('空串豁免：`icon: ""` 是「不给图标」，不是一个名字', () => {
    expect(collect('noise-empty.ts', 'const a = { icon: "" };\n').hits).toEqual([]);
  });

  it('判据文案自带出处：多枚漏册逐条列出文件与行号', () => {
    const raw = "const a = {\n  icon: 'nope-1',\n};\nconst c = <Icon name=\"nope-2\" />;\n";
    const scan = collect('mutant-report.ts', raw);
    expect(scan.hits.map((hit) => formatHit(scan, hit))).toEqual([
      "mutant-report.ts:2 · 'nope-1'（icon:）",
      "mutant-report.ts:4 · 'nope-2'（<Icon name=\"…\">）",
    ]);
  });
});
