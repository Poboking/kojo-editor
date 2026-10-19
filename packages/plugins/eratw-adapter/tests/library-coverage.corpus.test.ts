/**
 * ZH-2① · 函数表对真实语料的**调用点覆盖率闸**（`KOJO_SMOKE_PROJECT` 守门，无语料自动跳过）。
 *
 * ## 为什么要有这道闸
 * `ERATW_LIBRARY_FUNCTIONS`（基础库助手，游戏知识 ⇒ adapter）与 `SYSTEM_FUNCTION_ALIASES`
 * （引擎内建，跨游戏语言层 ⇒ kojo-sugar）此前**没有闸**：表被 pruning、或语料换代后高频
 * 函数悄悄掉出表外，作者侧只会多一条 `function-name-unknown` warning，测试面全绿。
 * 本闸把"两表覆盖语料外部函数调用点的比例"钉成**不变量**（≥ 阈值），不钉条目数 / 文件数 /
 * 逐调用点计数——那些一换版盘就假红（教训：`kernel/tests/encoding-roundtrip.test.ts` 钉死
 * `kojoTotal === 2294`，换 2,285 的盘直接把全量染红，BOARD §R ENC-1）。
 *
 * ## 口径（与降糖器同一把尺子）
 * 扫描语义逐字照 `kojo-sugar/src/system-functions.ts::lowerSystemFunctions`：
 * 跳过字符串字面量与 `;` 行注释、以 `identifier-chars` 的最大标识符为词元、词元后随 `(`
 * （允许空白）才算**调用点**。在此之上做四条**分类**过滤（不是新机制，只是"谁该被表认下来"）：
 * 1. **行首词元不计**——ERB 语句行首的 `NAME(` 是指令（`IF (` / `PRINTFORMW (`…），不是函数；
 * 2. **`CALLFORM` / `TRYCALLFORM` 后的名字不计**——引擎按表达式取名，非固定被调对象；
 * 3. **纯中文名不计**——函数名本身已是中文（`充填率(`）时不存在"缺中文别名"这回事；
 * 4. **`個人口上` 内有 `@` 定义者不计**——作者私有 `@函数`，规范 §7.2 明令排除在两张表外。
 * 剩下的调用点分两档：callee 在 `ERB/**`（`個人口上` 之外）有 `@` 定义 ⇒ **基础库档**
 * （adapter 表的领地）；全树无定义且形如 `^[A-Z][A-Z0-9_]+$` ⇒ **引擎内建档**（kojo-sugar 表的领地）。
 *
 * ## 阈值与余量（2026-10-16 实测 eraTW 4.980 画蛇添足版）
 * 扩容前基线：合并 **85.4%**（基础库 84.3% / 引擎内建 93.2%）。ZH-2① 后 **96.4%**。
 * **ADICT-1 全覆盖批**（2026-10-19）把基础库档剩余 320 名 / 1,563 调用点收完，实测
 * **合并 99.98%**（基础库 100% / 引擎内建 99.84%，仅剩 6 个无法可靠判义的内建名）。
 * 阈值随之抬到：
 * - 合并覆盖率 ≥ **0.99**（余量 ~1pp：扛语料换代带来的长尾构成漂移）；
 * - 基础库档 ≥ **0.99**、引擎内建档 ≥ **0.95**（内建档仍留更长尾部余量）；
 * - **反恒真护栏**：调用点总数 ≥ 20,000、不同函数名 ≥ 120——口径若被改坏到只数几个名字，
 *   覆盖率会假高，这两条会先红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERATW_LIBRARY_FUNCTIONS } from '../src/library-table';
import { SYSTEM_FUNCTION_ALIASES } from '../../kojo-sugar/src/system-functions';
import { isIdentPart, isIdentStart } from '../../kojo-sugar/src/identifier-chars';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 两表的原生 ERB 名（大小写不敏感命中，与引擎一致） */
const COVERED = new Set<string>([
  ...[...ERATW_LIBRARY_FUNCTIONS.values()].map((s) => s.toUpperCase()),
  ...[...SYSTEM_FUNCTION_ALIASES.values()].map((s) => s.toUpperCase()),
]);

/** 大小写不敏感取子项真名（语料根目录名会被重排，认内容不认名） */
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

/** 递归找 `個人口上`（作者口上域）；结构换层也能命中，找不到即判红 */
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

/** UTF-8 优先、失败回落 Shift-JIS（语料盘两种编码混存，纯 latin1 会把日文尾字节当 ASCII 词元） */
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

const isIdPartAt = (text: string, idx: number): boolean => isIdentPart(text[idx]!);

/** `NAME` + 可选空白 + `(` 的调用点收集器（口径见文件头） */
function scanCallSites(text: string, sink: (name: string, atLineStart: boolean, afterDynamic: boolean) => void): void {
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
    if (!isIdentStart(ch) || (i > 0 && isIdPartAt(text, i - 1))) {
      i++;
      continue;
    }
    let e = i + 1;
    while (e < text.length && isIdPartAt(text, e)) e++;
    const name = text.slice(i, e);
    let j = e;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === '(') {
      const before = text.slice(lineStart, i);
      sink(name, /^\s*$/u.test(before), DYNAMIC_RE.test(before));
    }
    i = e;
  }
}


describe.skipIf(!SMOKE)('函数表 · 真实语料调用点覆盖率闸（ZH-2①）', () => {
  it('两表覆盖率 ≥ 阈值（不变量式，非逐值硬钉）', () => {
    const root = SMOKE!;
    const erbDir = pick(root, 'ERB');
    expect(erbDir, `${root} 下找不到 ERB/（不是语料目录）`).toBeTruthy();
    const kojoDir = findKojoDir(erbDir!);
    expect(kojoDir, `${erbDir} 下找不到 個人口上/（语料结构换层，需人工确认口径）`).toBeTruthy();
    const kojoReal = kojoDir!;

    // 1) 定义面：口上域内 = 作者私有；口上域外（整个 ERB 树）= 游戏基础库
    const definedInKojo = new Set<string>();
    const definedInLibrary = new Set<string>();
    const erbFiles: string[] = [];
    for (const f of walkErb(erbDir!)) {
      erbFiles.push(f);
      const inKojo = f.startsWith(kojoReal);
      for (const line of readText(f).split(/\r?\n/u)) {
        const m = DEF_RE.exec(line);
        if (!m) continue;
        (inKojo ? definedInKojo : definedInLibrary).add(m[1]!.toUpperCase());
      }
    }

    // 2) 调用点面：只数口上域（作者真正书写中文函数的地方）
    const libraryTier = new Map<string, number>();
    const builtinTier = new Map<string, number>();
    const kojoFiles = erbFiles.filter((f) => f.startsWith(kojoReal));
    for (const f of kojoFiles) {
      scanCallSites(readText(f), (rawName, atLineStart, afterDynamic) => {
        if (atLineStart || afterDynamic) return; // 指令 / 动态取名：不是"该被表认下来"的函数
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(rawName) || rawName.length < 2) return; // 纯中文名不需别名
        const key = rawName.toUpperCase();
        if (definedInLibrary.has(key)) bump(libraryTier, key);
        else if (!definedInKojo.has(key) && /^[A-Z][A-Z0-9_]+$/u.test(key)) bump(builtinTier, key);
      });
    }

    const tally = (m: Map<string, number>) => {
      let total = 0;
      let hit = 0;
      const misses: Array<[string, number]> = [];
      for (const [name, n] of m) {
        total += n;
        if (COVERED.has(name)) hit += n;
        else misses.push([name, n]);
      }
      misses.sort((a, b) => b[1] - a[1]);
      return { total, hit, distinct: m.size, missDistinct: misses.length, topMiss: misses.slice(0, 12) };
    };
    const lib = tally(libraryTier);
    const eng = tally(builtinTier);
    const total = lib.total + eng.total;
    const hit = lib.hit + eng.hit;
    const rate = hit / total;

    console.log(
      `[函数表覆盖率] 口上文件 ${kojoFiles.length} | 合并 ${hit}/${total} = ${(rate * 100).toFixed(2)}% | ` +
        `基础库 ${lib.hit}/${lib.total} (${lib.distinct} 名) | ` +
        `引擎内建 ${eng.hit}/${eng.total} (${eng.distinct} 名) | 未覆盖 top: ${lib.topMiss.concat(eng.topMiss).slice(0, 10).map(([n, c]) => `${n}:${c}`).join(' ')}`,
    );

    // 3) 反恒真护栏：口径若被改坏（分母塌掉），覆盖率再高也不算数
    expect(total, '语料调用点总数异常偏低（口径被改坏？阈值将失去意义）').toBeGreaterThanOrEqual(20_000);
    expect(lib.distinct + eng.distinct, '语料外部函数名数异常偏低（口径被改坏？）').toBeGreaterThanOrEqual(120);

    // 4) 闸本体（阈值与余量理由见文件头；扩容前基线 85.4% ⇒ 0.90 是"真会红"的闸）
    expect(rate, `合并覆盖率 ${(rate * 100).toFixed(2)}% 低于阈值 99%（掉表了？）`).toBeGreaterThanOrEqual(0.99);
    expect(
      lib.hit / lib.total,
      `基础库档覆盖率 ${(100 * (lib.hit / lib.total)).toFixed(2)}% 低于阈值 99%`,
    ).toBeGreaterThanOrEqual(0.99);
    expect(
      eng.hit / eng.total,
      `引擎内建档覆盖率 ${(100 * (eng.hit / eng.total)).toFixed(2)}% 低于阈值 95%`,
    ).toBeGreaterThanOrEqual(0.95);
  }, 300_000);
});

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}
