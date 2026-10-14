/**
 * 术语守卫：上屏文案不许出现「糖」一族杜撰术语。作者词表只有 `.kojo 语言` / `.kojo 预览` /
 * `.kojo 校验` / `.kojo 转译检查` 这一套。
 *
 * 查的是**上屏文案**：字符串字面量（单引号 / 双引号 / 反引号，允许 `${…}` 插值）与 JSX 文本。
 * 不查注释、标识符、事件 id、localStorage 键、插件 id——那些不是作者读到的东西。
 *
 * 范围：`packages/app/src` 与 `packages/plugins/<插件>/src` 下的 `.ts` / `.tsx`（测试不在范围内）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 收回的术语（`糖` 单字收尾：语言别名 `['kojo','糖']` 的 `'糖'` 也在内） */
const BANNED = ['语法糖', '糖视图', '升糖', '降糖', '糖判定', '糖预览', '上糖', '糖'];

/** 字符串字面量（单双引号不跨行；反引号可跨行并容忍 `${…}`） */
const LITERAL_RE = /'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"|`(?:[^`\\]|\\[\s\S])*`/g;

/** 一处只报一次（长词先匹配，`语法糖视图` 不会重复报成 `糖视图`） */
const TERM_RE = new RegExp([...BANNED].sort((a, b) => b.length - a.length).join('|'), 'g');

/** 正则字面量会带裸引号（`/'/`）与裸反引号（`/`/`），先按代码位置识别并抹掉，才谈得上配对 */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'new',
  'delete',
  'void',
  'yield',
  'await',
  'instanceof',
  'throw',
]);

/** `/` 处在「可以开正则」的位置吗（按抹掉前已产出的文本回看） */
function atRegexStart(before: string): boolean {
  const t = before.replace(/\s+$/, '');
  if (t.length === 0) return true;
  const last = t[t.length - 1]!;
  if (!/[\w$)\]]/.test(last)) return true;
  const word = /[\w$]+$/.exec(t.slice(-16))?.[0] ?? '';
  return REGEX_KEYWORDS.has(word);
}

/**
 * 抹掉注释与正则字面量（长度不变，字符串原文照抄），返回可安全抽字面量的文本。
 *
 * 为什么要状态机而不是一个正则：注释里的引号会冒充字符串开头、正则里的引号会打断配对，
 * 两者都会让守卫把整段代码当成字符串——守卫误报一次，就再没人信它。
 */
function maskNonStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && atRegexStart(out)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break;
        if (inClass) {
          if (ch === ']') inClass = false;
          j++;
          continue;
        }
        if (ch === '[') {
          inClass = true;
          j++;
          continue;
        }
        if (ch === '/') {
          j++;
          while (j < n && /[gimsuyvd]/.test(src[j]!)) j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        out += blank(src.slice(i, j));
        i = j;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = src[j]!;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        if ((c === "'" || c === '"') && ch === '\n') break;
        j++;
      }
      if (closed) {
        out += src.slice(i, j);
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function sourceFiles(): string[] {
  const roots = [path.join(ROOT, 'packages', 'app', 'src')];
  const pluginsDir = path.join(ROOT, 'packages', 'plugins');
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (e.isDirectory()) roots.push(path.join(pluginsDir, e.name, 'src'));
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const rel = (abs: string): string => path.relative(ROOT, abs).replaceAll('\\', '/');

/** 命中的术语按长到短报，免得一处只报出「糖」 */
function matchedTerms(s: string): string[] {
  return [...BANNED].sort((a, b) => b.length - a.length).filter((t) => s.includes(t));
}

describe('用户可见文案不含「糖」一族术语', () => {
  const files = sourceFiles();

  it('扫描面不为空（守卫别在空目录上自欺）', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('字符串字面量里没有这些术语', () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const masked = maskNonStrings(src);
      for (const m of masked.matchAll(LITERAL_RE)) {
        const terms = matchedTerms(m[0]);
        if (terms.length > 0) {
          hits.push(`${rel(f)}:${lineOf(src, m.index!)} [${terms.join(', ')}] ${m[0].replace(/\n/g, '⏎').slice(0, 120)}`);
        }
      }
    }
    expect(hits, `字符串字面量里仍有旧术语：\n${hits.join('\n')}`).toEqual([]);
  });

  it('JSX 文本（不在引号里的上屏字）也没有这些术语', () => {
    const hits: string[] = [];
    for (const f of files) {
      if (!/\.tsx$/.test(f)) continue;
      const src = readFileSync(f, 'utf8');
      const masked = maskNonStrings(src).replace(LITERAL_RE, (s) => ' '.repeat(s.length));
      for (const m of masked.matchAll(TERM_RE)) {
        const line = lineOf(src, m.index!);
        hits.push(`${rel(f)}:${line} [${m[0]}] ${src.split('\n')[line - 1]!.trim().slice(0, 120)}`);
      }
    }
    expect(hits, `JSX 文本里仍有旧术语：\n${hits.join('\n')}`).toEqual([]);
  });

  /**
   * 两处**看起来不像 UI、其实会咬人**的下游：作者样例文件（整篇都是给人读的散文）与
   * `tools/*.mjs` 里的选择器/标签字符串——按 aria-label 找弹窗的探针，改了文案不改它就静默失效。
   */
  it('作者样例文件与 tools 脚本的文案也没有这些术语', () => {
    const hits: string[] = [];
    for (const dir of ['sugar', 'scaffold']) {
      const d = path.join(ROOT, 'fixtures', dir);
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !/\.(kojo|erb|ERB)$/.test(e.name)) continue;
        const f = path.join(d, e.name);
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(TERM_RE)) {
          hits.push(`${rel(f)}:${lineOf(src, m.index!)} [${m[0]}]`);
        }
      }
    }
    const toolsDir = path.join(ROOT, 'tools');
    for (const e of readdirSync(toolsDir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.[cm]js$/.test(e.name)) continue;
      const f = path.join(toolsDir, e.name);
      const src = readFileSync(f, 'utf8');
      for (const m of maskNonStrings(src).matchAll(LITERAL_RE)) {
        const terms = matchedTerms(m[0]);
        if (terms.length > 0) {
          hits.push(`${rel(f)}:${lineOf(src, m.index!)} [${terms.join(', ')}] ${m[0].replace(/\n/g, '⏎').slice(0, 120)}`);
        }
      }
    }
    expect(hits, `样例文件 / tools 脚本里仍有旧术语：\n${hits.join('\n')}`).toEqual([]);
  });
});
