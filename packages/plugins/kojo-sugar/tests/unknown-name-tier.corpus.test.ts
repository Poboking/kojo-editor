/**
 * ZH-D1 · **分级判据的盘上自证**（`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，无语料自动跳过；语料盘**只读**）。
 *
 * 钉的是"为什么不是一刀切升 error"与"分级后到底新增几条 error"两件事在**真盘**上的数字
 * （判据层单测见 `unknown-name-tier.test.ts`，那边钉规则、这边钉规则对不对得上盘）：
 *
 * 1. **一刀切的代价**（本批拒绝它的数据理由）：真语料 `個人口上` 的中文函数名**调用形态**
 *    落点里，两张函数表**都不认**的是长尾主体（2026-10-16 实测 eraTW 4.980 画蛇添足版：
 *    1,396 处中文调用点，ZH-D1 收录批**补名前** 全部表外 = 324 名 / 263 文件；按同一收录判据
 *    补 13 条恒等条目**后**仍剩 **526 处 / 311 名 / 158 个文件**，头部 `SHOW_上半身内衣`… 之流
 *    多为项目/基础库 `@函数` 的合法中文写法）。把 `function-name-unknown` 全升 error =
 *    打开这 158 个文件（6.9%）就一屏红、且 error 存在即拒绝产字节 ⇒ 产品坏掉。
 * 2. **分级的零误伤**：只把"表外名**且**表内唯一高置信**别名**近名"升 error（`suggestFunctionName`），
 *    同一张盘新增 error 必须**贴地**（本闸给绝对上限 + 占比上限）。两条"判据若被放宽就会红"的实证：
 *    ① 允许**两字名**当近邻 ⇒ 这张盘冒 10 处误伤（`随意`↔`随机`、`随便`↔`随机`、`参数`↔`参数消息甲`）；
 *    ② 允许**恒等条目**（盘上名本身就是中文/日文的函数）当候选 ⇒ 冒 13 处误伤（`SHOW_上半身内衣`↔
 *    `SHOW_下半身内衣`、`仕事日チェック`↔`仕事中チェック`、`金额表示`↔`金額表示`，都是盘上各有
 *    `@` 定义的**双生真函数**）。②是本批补名表时**由这道闸当场抓到**的（判据因此多了"只认别名条目"
 *    这一条限制，见 `system-functions.ts::candidatePool`）。
 *
 * 扫描口径与 `lowerSystemFunctions` / `eratw-adapter/tests/library-coverage.corpus.test.ts` 逐字同构：
 * 跳字符串字面量与 `;` 注释、取 `identifier-chars` 最大标识符整词、词元后随 `(`（允许空白）才算
 * 调用点；**行首词元不计**（ERB 语句行首的 `名(` 是指令）、`CALLFORM`/`TRYCALLFORM` 后不计、
 * 在 `個人口上` 内有 `@` 定义者不计（作者私有 `@函数`，规范 §7.2）。与那张覆盖率闸的分工：
 * 它数**拉丁名**调用点（"该有中文别名却没有"），本闸数**中文名**调用点（"作者写的名字表不认"）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEratwLibraryTable, ERATW_LIBRARY_FUNCTIONS } from '../../eratw-adapter/src/library-table';
import { isIdentPart, isIdentStart } from '../src/identifier-chars';
import { isKnownFunctionName, suggestFunctionName } from '../src/system-functions';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 升档上限（绝对 + 占比）——理由见文件头第 2 条：低于"放宽判据"实测冒出的 10 处误伤 */
const UPGRADED_SITES_CAP = 5;
const UPGRADED_NAME_CAP = 5;
const UPGRADED_RATE_CAP = 0.005;

/** 认内容不认名（语料根目录 / 子目录名会被重排） */
function pick(dir: string, name: string): string | null {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.toLowerCase() === name.toLowerCase()) return join(dir, e.name);
    }
  } catch {
    return null;
  }
  return null;
}

function findKojoDir(dir: string, depth = 6): string | null {
  const direct = pick(dir, '個人口上');
  if (direct) return direct;
  if (depth <= 0) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const hit = findKojoDir(join(dir, e.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}

function walkErb(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkErb(p, out);
    else if (/\.er[bm]$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** UTF-8 优先、失败回落 Shift-JIS（语料盘两种编码混存） */
function readText(path: string): string {
  const buf = readFileSync(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

const DEF_RE = /^\s*@([A-Za-z0-9_぀-ヿ㐀-䶿一-鿿Ｆ-Ｚｆ-ｚ]+)/u;
const DYNAMIC_RE = /(?:^|\s)(?:CALLFORM|TRYCALLFORM)\s*@?$/i;
const CJK = /[぀-ヿ㐀-䶿一-鿿Ｆ-ｚ]/;

/** 中文调用点收集器（口径与 `lowerSystemFunctions` 同构；行首 / 动态取名 / `@` 私有不计） */
function scanChineseCallSites(
  text: string,
  privateNames: ReadonlySet<string>,
  sink: (name: string) => void,
): void {
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      i++;
      lineStart = i;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') i++;
      i++;
      continue;
    }
    if (ch === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (!isIdentStart(ch) || (i > 0 && isIdentPart(text[i - 1]!))) {
      i++;
      continue;
    }
    let e = i + 1;
    while (e < text.length && isIdentPart(text[e]!)) e++;
    const name = text.slice(i, e);
    let j = e;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === '(') {
      const before = text.slice(lineStart, i);
      if (!/^\s*$/u.test(before) && !DYNAMIC_RE.test(before) && CJK.test(name) && !privateNames.has(name)) {
        sink(name);
      }
    }
    i = e;
  }
}

describe.skipIf(!SMOKE)('ZH-D1 · 表外中文名分级判据的盘上自证', () => {
  it('一刀切升 error 的代价与分级的零误伤（不变量式上限）', () => {
    const root = SMOKE!;
    const erbDir = pick(root, 'ERB');
    expect(erbDir, `${root} 下找不到 ERB/（不是语料目录）`).toBeTruthy();
    const kojoDir = findKojoDir(erbDir!);
    expect(kojoDir, `${erbDir} 下找不到 個人口上/（语料结构换层，需人工确认口径）`).toBeTruthy();

    const files = walkErb(erbDir!).filter((f) => f.startsWith(kojoDir!));
    const texts = new Map(files.map((f) => [f, readText(f)] as const));
    // 作者私有 `@函数` 名单（规范 §7.2 明令排除在两张表外，本闸同样不计）
    const privateNames = new Set<string>();
    for (const t of texts.values()) {
      for (const line of t.split(/\r?\n/u)) {
        const m = DEF_RE.exec(line);
        if (m) privateNames.add(m[1]!);
      }
    }

    const libraryTable = createEratwLibraryTable(ERATW_LIBRARY_FUNCTIONS);
    const unlisted = new Map<string, number>();
    const upgraded = new Map<string, string>(); // 表外名 → 唯一近名（升 error 档）
    const unlistedFiles = new Set<string>();
    const upgradedFiles = new Set<string>();
    let chineseCallSites = 0;
    for (const [f, t] of texts) {
      scanChineseCallSites(t, privateNames, (name) => {
        chineseCallSites++;
        if (isKnownFunctionName(name, libraryTable)) return;
        unlisted.set(name, (unlisted.get(name) ?? 0) + 1);
        unlistedFiles.add(f);
        const near = suggestFunctionName(name, libraryTable);
        if (near) {
          upgraded.set(name, near.name);
          upgradedFiles.add(f);
        }
      });
    }
    const unlistedSites = [...unlisted.values()].reduce((a, b) => a + b, 0);
    const upgradedSites = [...upgraded.keys()].reduce((a, n) => a + (unlisted.get(n) ?? 0), 0);
    const rate = unlistedSites === 0 ? 0 : upgradedSites / unlistedSites;

    console.log(
      `[ZH-D1 分级普查] 口上文件 ${files.length} | 中文调用点 ${chineseCallSites} | 表外 ${unlistedSites} 点 / ${unlisted.size} 名 / ${unlistedFiles.size} 文件（= 一刀切升 error 的新增条数与变红文件数） | 分级升档 ${upgradedSites} 点 / ${upgraded.size} 名 / ${upgradedFiles.size} 文件 = ${(rate * 100).toFixed(2)}%${upgraded.size ? ` | 明细 ${[...upgraded].map(([n, c]) => `${n}→${c}`).join(' ')}` : ''}`,
    );

    // 1) 反恒真护栏：口径若被改坏（分母塌掉），"零误伤"会假绿，这两条先红
    expect(unlistedSites, '语料表外中文调用点异常偏低（扫描口径被改坏？本闸失去意义）').toBeGreaterThanOrEqual(300);
    expect(unlisted.size, '语料表外中文函数名数异常偏低（扫描口径被改坏？）').toBeGreaterThanOrEqual(100);
    // 2) 一刀切的代价（本批拒绝它的量化理由，必须**大到**看得出会一屏红）
    expect(
      unlistedSites,
      '表外点位太少 ⇒ "一刀切升 error"的代价论据不再成立，需重新评估分级（并把上限一起收紧）',
    ).toBeGreaterThanOrEqual(300);
    expect(unlistedFiles.size, '受影响的真实文件数太少 ⇒ 同上，需重新评估分级').toBeGreaterThanOrEqual(50);
    // 3) 分级后升档贴地（判据被放宽就会红：见文件头第 2 条的 10 处误伤）
    expect(upgradedSites, `分级升档 ${upgradedSites} 处超绝对上限（判据被放宽？明细见日志）`).toBeLessThanOrEqual(
      UPGRADED_SITES_CAP,
    );
    expect(upgraded.size, `升档名数 ${upgraded.size} 超上限（判据被放宽？）`).toBeLessThanOrEqual(UPGRADED_NAME_CAP);
    expect(rate, `升档占比 ${(rate * 100).toFixed(2)}% 超上限（判据被放宽？）`).toBeLessThanOrEqual(
      UPGRADED_RATE_CAP,
    );
  }, 300_000);
});
