/**
 * eraFL 库函数表 · 对真实语料的**调用点覆盖率闸**（真盘守卫：`D:/Game/erafl` 不在即跳过）。
 *
 * ## 为什么要有这道闸
 * `ERAFL_LIBRARY_FUNCTIONS` 是"从语料里读出来的"表。表被 pruning、或语料换代后高频函数
 * 悄悄掉出表外，作者侧只会多一条 `function-name-unknown` warning —— 测试面全绿。
 * 本闸把「表对**口上域**基础库调用点的覆盖比例」钉成不变量（≥ 阈值），**不钉**条目数 /
 * 逐函数计数（那些一换版盘就假红）。
 *
 * ## 口径（与降糖器同一把尺子；逐字照 eraTW `library-coverage.corpus.test.ts` 头注）
 * 扫描跳过字符串字面量与 `;` 注释、取最大标识符为词元、词元后随 `(` 才算调用点；再叠四条过滤：
 * 1. **行首词元不计**——语句行首的 `NAME(` 是指令（`IF (` / `PRINTFORMW (`…）；
 * 2. **`CALLFORM` / `TRYCALLFORM` 后的名字不计**——引擎按表达式取名；
 * 3. **纯中文名不计**——名字本身已是中文，不存在"缺中文别名"；
 * 4. **口上域内有 `@` 定义者不计**——作者私有 `@函数`（规范 §7.2 排除在表外）。
 * 剩下的调用点里，callee 在 `ERB/**`（口上域之外）有 `@` 定义 ⇒ **基础库档**（本表的领地）。
 *
 * ## 阈值与余量（2026-10-25 实测 `D:/Game/erafl`）
 * - 口上域 ERB **417 份 / 8,990 个基础库调用点 / 226 个不同函数名**；
 * - 本表 170 名覆盖 **8,933 = 99.37%**；未收的 55 名全是**各 1 次**的长尾（57 处），
 *   另有 1 名（`取参数等级`）因与系统表撞名且口上域零调用而刻意不收
 *   （`ERAFL_LIBRARY_CONFLICTS`，对本覆盖率**零影响**——它本来就没有调用点）；
 * - 阈值取 **0.99**（余量 0.37pp：扛语料换代带来的长尾构成漂移；掉一个 14 次的
 *   `AUTOCOM_SET_PRIORITY_CUSTOM` 就到 99.21% 仍绿，掉一个 40 次的头部即红——
 *   这正是"真会红"的尺度）；
 * - **反恒真护栏**：调用点总数 ≥ 5,000、不同函数名 ≥ 120（口径被改坏到只数几个名字时先红）。
 *
 * ## 第二道闸：逐条存在性
 * 表里每个原生名都必须**在口上域之外**有 `@` 定义（反向证明"不是拍脑袋写的"），
 * 且**不得**是口上域内的作者私有函数（收了就是越界）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIdentPart, isIdentStart } from '../../kojo-sugar/src/identifier-chars';
import { ERAFL_LIBRARY_FUNCTIONS } from '../src/library-table';

const GAME_ROOT = 'D:/Game/erafl';
const ERB_ROOT = join(GAME_ROOT, 'ERB');
const KOJO_ROOT = join(ERB_ROOT, '口上');
const hasCorpus = existsSync(ERB_ROOT) && existsSync(KOJO_ROOT);

/** 表内原生名（大小写不敏感命中，与引擎一致） */
const COVERED = new Set<string>([...ERAFL_LIBRARY_FUNCTIONS.values()].map((s) => s.toUpperCase()));

function walkErb(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkErb(p, out);
    else if (/\.erb$/i.test(name)) out.push(p);
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

function scanCallSites(
  text: string,
  sink: (name: string, atLineStart: boolean, afterDynamic: boolean) => void,
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
    if (text[j] === '(') sink(name, /^\s*$/u.test(text.slice(lineStart, i)), DYNAMIC_RE.test(text.slice(lineStart, i)));
    i = e;
  }
}

const bump = (m: Map<string, number>, key: string): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};

describe.skipIf(!hasCorpus)('eraFL 库函数表 · 真实语料调用点覆盖率闸', () => {
  it('口上域基础库调用点覆盖率 ≥ 99%，且表内每条都真在盘上', () => {
    // 1) 定义面：口上域内 = 作者私有；口上域外（整个 ERB 树）= 游戏基础库
    const definedInKojo = new Set<string>();
    const definedInLibrary = new Map<string, string>();
    for (const f of walkErb(ERB_ROOT)) {
      const inKojo = f.startsWith(KOJO_ROOT);
      for (const line of readText(f).split(/\r?\n/u)) {
        const m = DEF_RE.exec(line);
        if (!m) continue;
        const key = m[1]!.toUpperCase();
        if (inKojo) definedInKojo.add(key);
        else if (!definedInLibrary.has(key)) definedInLibrary.set(key, f);
      }
    }
    // 反恒真：口上域必须真的被切出来（路径判错 / 目录改名时，下面所有口径都会假绿）
    expect(definedInKojo.size, '口上域没识别出 @ 定义（KOJO_ROOT 判错？）').toBeGreaterThan(1_000);

    // 2) 逐条存在性：表里每个原生名都必须在**口上域之外**有定义
    const ghosts = [...COVERED].filter((n) => !definedInLibrary.has(n));
    expect(ghosts, `表内这些名字在语料里找不到 @ 定义（拍脑袋写的？）：${ghosts.join('、')}`).toEqual([]);
    // 2b) 命名族护栏：作者私有族（`KOJO_*_K##` / `M_KOJO*`）一律不得进表
    const privateFam = [...COVERED].filter((n) => /^KOJO_.*_K\d+$/.test(n) || /^M_KOJO/.test(n));
    expect(privateFam, `表内混进了作者私有命名族：${privateFam.join('、')}`).toEqual([]);

    // 3) 调用点面：只数口上域（作者真正书写中文函数名的地方）
    const libraryTier = new Map<string, number>();
    let kojoFiles = 0;
    for (const f of walkErb(KOJO_ROOT)) {
      kojoFiles++;
      scanCallSites(readText(f), (rawName, atLineStart, afterDynamic) => {
        if (atLineStart || afterDynamic) return;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(rawName) || rawName.length < 2) return;
        const key = rawName.toUpperCase();
        if (definedInLibrary.has(key)) bump(libraryTier, key);
      });
    }

    let total = 0;
    let hit = 0;
    const misses: Array<[string, number]> = [];
    for (const [name, n] of libraryTier) {
      total += n;
      if (COVERED.has(name)) hit += n;
      else misses.push([name, n]);
    }
    misses.sort((a, b) => b[1] - a[1]);
    const rate = hit / total;

    console.log(
      `[eraFL 函数表覆盖率] 口上文件 ${kojoFiles} | 基础库 ${hit}/${total} = ${(rate * 100).toFixed(2)}% | ` +
        `在表 ${COVERED.size} 名 / 语料 ${libraryTier.size} 名 | 未覆盖 top: ` +
        misses.slice(0, 10).map(([n, c]) => `${n}:${c}`).join(' '),
    );

    // 4) 反恒真护栏
    expect(total, '口上域基础库调用点总数异常偏低（口径被改坏？阈值将失去意义）').toBeGreaterThanOrEqual(5_000);
    expect(libraryTier.size, '口上域外部函数名数异常偏低（口径被改坏？）').toBeGreaterThanOrEqual(120);

    // 5) 闸本体
    expect(rate, `基础库档覆盖率 ${(rate * 100).toFixed(2)}% 低于阈值 99%（掉表了？）`).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});
