/**
 * F12 记号尺 · 真实语料 A/B 自证（F12-TOKEN 批，2026-10-19；
 * `KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，语料不在位整件跳过——**不拿合成盘冒充读数**）。
 *
 * 这一件是那张判据改动的**存在理由**，所以读数钉在这里而不是注释里（本轮实测，
 * 语料根 = `<语料>/ERB`，3,971 份方言文件）：
 * 1. **分母**：根内 `@` 定义头 113,833 行，进索引的函数 110,194 条，其中名字含非 ASCII 的
 *    **25,003 条 = 22.69%**（整份语料含根外 `.erb/.erh/.erd` 另计得 128,235 头 / 27,032 含
 *    非 ASCII = 21.08%，与简报的 128,736 / 27,171 同一量级——分母口径就是扫描面）。
 * 2. **放宽前**：在这 25,003 个中文名的 50,006 个名字点位（名字首格 + 中间格）上，
 *    ASCII 尺给出 45,035 次**残缺**记号（混排名被切成半截），其中查得到定义的只有 **61 次
 *    （0.12%）**；端到端 `definitionTargetsAt` 抽样 251 点 **0 命中**——F12 是瞎的。
 * 3. **放宽后**：同批点位 49,909 次给出完整记号、**49,848 次查得到定义（99.68%）**；
 *    端到端抽样 251 点命中 **250**；CALL 名字槽 9,958 点从 4 → **9,958**（100%），
 *    表达式里的提及 8,777 点从 4 → **8,777**（100%）。
 * 4. **误命中面（头注"宁可窄"唯一真实代价）**：1,269,664 个中文散文光标点位（整行注释 /
 *    行内注释尾巴 / 字符串台词）里，改前已有 1,903 个答得出定义（0.150%，ASCII 名在注释里
 *    本来就跳），改后 3,287 个（**0.259%**）——新增 **1,384 个（0.109%）**。每一个新增点位的
 *    落点都是"光标下那一整串恰好等于某个函数的名字"，不是"跳到不相干的行"；同一批点位上
 *    紧邻冒号的成员访问（`族:充填率`）有 **46** 个恰好也是函数名，被 `colonAdjacent` 退让挡掉。
 * 5. **优先序依据（同一趟里量）**：eraTW 库表 471 条中原生名含非 ASCII 的 **13** 条，
 *    13/13 是恒等条目（`充填率`→`充填率`）且 13 条**全部**在函数索引里有 `@` 定义；
 *    原生名为 ASCII 且同时在库表与索引里的 **458** 条**全部**带真翻译（恒等 0 条）；
 *    系统函数表反向的中文键 **0** 条。⇒ 放宽反查那把尺只会让 13 条回显抢掉正文，
 *    而"函数索引一律优先"会打沉 458 条真翻译（库表 97.2%）；恒等/翻译这条判据恰好切开两半。
 *
 * 口径：取词一律走生产判据（`parseErbText` → `aggregateIndex` → `scanFileRefs` →
 * `definitionTargetsAt`），"改前"那一臂用契约 ASCII 尺就地复算（那是改前 `definitionTargetsAt`
 * 的实际取词步），其余臂全部调真函数——把判据换回 ASCII 尺，本文件的"后"臂立刻红。
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS, symbolTokenAt } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import { aggregateIndex } from '../src/snapshot';
import { definitionTargetsAt } from '../src/symbols';
import { buildReferenceIndex, functionNameTokenAt, scanFileRefs, type FileRefs } from '../src/references';
import { ERATW_LIBRARY_FUNCTIONS } from '../../eratw-adapter/src/library-table';
import { SYSTEM_FUNCTION_REVERSE } from '../../kojo-sugar/src/system-functions';

const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const HAS_CJK = /[^\x20-\x7e]/;
const IDENT_ONE = /[\p{L}\p{N}_]/u;

/** 语料根 = `<corpus>/ERB`（编辑器索引的 kojo 根同一片；只读） */
function dialectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if ((ERB_DIALECT_EXTENSIONS as readonly string[]).includes(path.extname(p).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

const linesOf = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** 一段文本里的连续记号（0 基半开区间）——与 `MODEL_TOKEN_CLASS` 同一把尺的朴素走位 */
function identRuns(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (!IDENT_ONE.test(text[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && IDENT_ONE.test(text[i]!)) i++;
    out.push({ start, end: i, text: text.slice(start, i) });
  }
  return out;
}

/** 字符串字面量的**内部**区间（未闭合按到行尾；与 `codeViewOf` 同一套引号走位） */
function stringBodies(line: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') {
      i++;
      continue;
    }
    const start = i + 1;
    let j = start;
    while (j < line.length && line[j] !== '"') j++;
    out.push([start, j]);
    i = j + 1;
  }
  return out;
}

interface Point {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

describe('F12 记号尺 · 真实语料 A/B（命中率前/后 + 误命中面）', () => {
  it.skipIf(!SMOKE)(
    '中文名点位：ASCII 尺 0.12% → Unicode 尺 99%+；散文点位代价 0.11% 新增可跳',
    { timeout: 900_000 },
    () => {
      const root = path.join(SMOKE!, 'ERB');
      const files = dialectFiles(root);
      expect(files.length).toBeGreaterThan(1_000);

      // ---------- 第一趟：解析 + 聚合（文本不留驻） ----------
      const parsed: ErbFile[] = [];
      let atDefLines = 0;
      for (const p of files) {
        const text = readFileSync(p, 'utf8');
        atDefLines += linesOf(text).filter((l) => l.trimStart().startsWith('@')).length;
        parsed.push(parseErbText(text, p));
      }
      const agg = aggregateIndex(parsed);
      const index = { files: agg.files, byName: agg.byName } as unknown as ErbIndex;
      const hasName = (upper: string): boolean => agg.byName.has(upper);

      // ---------- 第二趟：反向引用索引（生产判据同一条遍历） ----------
      const refsByPath = new Map<string, FileRefs>();
      for (const p of files) refsByPath.set(p, scanFileRefs(readFileSync(p, 'utf8'), hasName));
      const references = buildReferenceIndex(parsed, refsByPath);

      const allDefs = [...agg.byName.values()].flat();
      const cjkDefs = allDefs.filter((r) => HAS_CJK.test(r.name));
      const cjkNames = new Set(cjkDefs.map((r) => r.normalizedName));

      // ---------- 分母 ----------
      // 索引根 = `<语料>/ERB`（编辑器 `project.kojoPaths` 那一片）；整份语料（含根外
      // `.erb/.erh/.erd`）另计得 128,235 条 `@` 头 / 27,032 条含非 ASCII = 21.08%，
      // 与简报给的 128,736 / 27,171（21.1%）同一量级——**分母口径 = 扫描面**，这里钉的是本根。
      expect(atDefLines).toBeGreaterThanOrEqual(113_000);
      expect(cjkDefs.length).toBeGreaterThan(24_000);
      const cjkShare = cjkDefs.length / allDefs.length;
      expect(cjkShare).toBeGreaterThan(0.2);
      expect(cjkShare).toBeLessThan(0.3);

      const lineCache = new Map<string, string[]>();
      const lineAt = (p: string, line: number): string => (lineCache.get(p) ?? lineCache.set(p, linesOf(readFileSync(p, 'utf8'))).get(p)!)[line - 1] ?? '';

      /** 名字起点列（索引里有就用工件里的，没有就从原文现算） */
      const nameColumnOf = (filePath: string, startLine: number, name: string): number => {
        const lineText = lineAt(filePath, startLine);
        const at = lineText.indexOf(name);
        return at < 0 ? -1 : at + 1;
      };

      const arms = (points: Point[]): { beforeToken: number; beforeHit: number; afterToken: number; afterHit: number } => {
        let beforeToken = 0;
        let beforeHit = 0;
        let afterToken = 0;
        let afterHit = 0;
        for (const pt of points) {
          const lineText = lineAt(pt.path, pt.line);
          const b = symbolTokenAt(lineText, pt.column);
          if (b) {
            beforeToken++;
            if (agg.byName.has(b.text.toUpperCase())) beforeHit++;
          }
          const a = functionNameTokenAt(lineText, pt.column);
          if (a) {
            afterToken++;
            if (agg.byName.has(a.text.toUpperCase())) afterHit++;
          }
        }
        return { beforeToken, beforeHit, afterToken, afterHit };
      };

      // ---------- ① 定义行名字点位（首格 + 中间格） ----------
      const defPoints: Point[] = [];
      for (const def of cjkDefs) {
        const start = def.nameColumn ?? nameColumnOf(def.filePath, def.startLine, def.name);
        if (start < 1) continue;
        defPoints.push({ path: def.filePath, line: def.startLine, column: start });
        defPoints.push({ path: def.filePath, line: def.startLine, column: start + Math.floor(def.name.length / 2) });
      }
      const defArms = arms(defPoints);
      expect(defPoints.length).toBeGreaterThan(48_000);
      expect(defArms.beforeHit / defPoints.length).toBeLessThan(0.01); // 改前：<1% 能跳
      expect(defArms.afterHit / defPoints.length).toBeGreaterThan(0.95); // 改后：>95% 能跳
      // 绝对量下限（换尺这一步本身的价值；判据退回 ASCII 尺 ⇒ 这两条立刻红）
      expect(defArms.afterHit).toBeGreaterThanOrEqual(49_000);
      expect(defArms.beforeHit).toBeLessThanOrEqual(200);

      // ---------- ② CALL 名字槽 / 表达式里的提及 ----------
      const sitePoints = (kind: 'call' | 'mention'): Point[] => {
        const out: Point[] = [];
        for (const [name, list] of references.bySymbol) {
          if (!cjkNames.has(name)) continue;
          for (const ref of list) if (ref.kind === kind) out.push({ path: ref.filePath, line: ref.line, column: ref.column });
        }
        return out;
      };
      const callArms = arms(sitePoints('call'));
      const mentionArms = arms(sitePoints('mention'));
      expect(callArms.afterHit).toBe(callArms.afterToken); // 反向索引记进表的点，取词腿必须原样取回
      expect(mentionArms.afterHit).toBe(mentionArms.afterToken);
      expect(callArms.beforeHit).toBeLessThan(50);
      expect(mentionArms.beforeHit).toBeLessThan(50);

      // ---------- 端到端（真 `definitionTargetsAt`，抽样；标签腿/`$` 行也一并穿过） ----------
      const sampled = defPoints.filter((_, i) => i % 200 === 0);
      let e2eAfter = 0;
      let e2eBefore = 0;
      for (const pt of sampled) {
        // **整份文件文本**进 `definitionTargetsAt`（它按 `line` 自己切行；只喂一行会让
        // 除第 1 行以外的点位全判"行越界"，读数就成了假的 0）
        const fullText = readFileSync(pt.path, 'utf8');
        if (definitionTargetsAt(index, pt.path, fullText, pt.line, pt.column).length > 0) e2eAfter++;
        // 改前的取词步（其余腿逐字不变）：ASCII 尺给不出名字 ⇒ 空数组
        const b = symbolTokenAt(lineAt(pt.path, pt.line), pt.column);
        if (b && agg.byName.has(b.text.toUpperCase())) e2eBefore++;
      }
      expect(e2eBefore).toBeLessThanOrEqual(1); // 改前端到端几乎全瞎（实测 0 / 251 抽样点）
      expect(e2eAfter / sampled.length).toBeGreaterThan(0.9);

      // ---------- ③ 误命中面：中文散文点位 ----------
      const prosePoints: Point[] = [];
      for (const p of files) {
        const ls = linesOf(readFileSync(p, 'utf8'));
        for (let li = 0; li < ls.length; li++) {
          const raw = ls[li]!;
          const segments: string[] = [];
          if (raw.trimStart().startsWith(';')) segments.push(raw);
          else {
            for (const [a, b] of stringBodies(raw)) if (b > a) segments.push(' '.repeat(a) + raw.slice(a, b));
            const semi = raw.indexOf(';');
            if (semi >= 0 && !raw.slice(0, semi).includes('"')) segments.push(' '.repeat(semi) + raw.slice(semi));
          }
          for (const seg of segments) {
            for (const run of identRuns(seg)) {
              if (!HAS_CJK.test(run.text)) continue;
              prosePoints.push({ path: p, line: li + 1, column: run.start + Math.floor(run.text.length / 2) + 1 });
            }
          }
        }
      }
      const proseArms = arms(prosePoints);
      expect(prosePoints.length).toBeGreaterThan(1_000_000);
      // 代价面：散文点位里答得出定义的比例（改前后各一次），以及"新增可跳"的绝对量
      const proseBeforeShare = proseArms.beforeHit / prosePoints.length;
      const proseAfterShare = proseArms.afterHit / prosePoints.length;
      expect(proseAfterShare).toBeLessThan(0.01); // 放宽后仍 <1% 的散文点位会给定义
      const newJumps = proseArms.afterHit - proseArms.beforeHit;
      expect(newJumps).toBeGreaterThanOrEqual(0);
      expect(newJumps / prosePoints.length).toBeLessThan(0.005);
      expect(newJumps).toBeGreaterThanOrEqual(1_000); // 代价面是真的（不是"零代价"式自夸）

      // 冒号退让挡掉的量（同批散文点位里"记号紧邻冒号且整串是函数名"的点位）
      let colonBlocked = 0;
      for (const pt of prosePoints) {
        const lineText = lineAt(pt.path, pt.line);
        const bare = functionNameTokenAt(lineText, pt.column);
        if (bare) continue;
        const run = identRuns(lineText).find((r) => r.start + 1 <= pt.column && pt.column <= r.end);
        if (run && agg.byName.has(run.text.toUpperCase())) colonBlocked++;
      }
      expect(colonBlocked).toBeGreaterThan(0); // 这条判据在真语料上不是空转

      // ---------- ④ 库表侧的优先序依据（读数钉在判据处） ----------
      const entries = [...ERATW_LIBRARY_FUNCTIONS.entries()];
      const cjkNative = entries.filter(([, erb]) => HAS_CJK.test(erb));
      const echoCjkNative = cjkNative.filter(([cn, erb]) => cn === erb);
      const cjkNativeInIndex = cjkNative.filter(([, erb]) => agg.byName.has(erb.toUpperCase()));
      const asciiBoth = entries.filter(([, erb]) => !HAS_CJK.test(erb) && agg.byName.has(erb.toUpperCase()));
      const asciiEchoBoth = asciiBoth.filter(([cn, erb]) => cn === erb); // 恒等条目（原生名 === 中文名）
      expect(entries.length).toBeGreaterThan(400);
      expect(echoCjkNative.length).toBe(cjkNative.length); // 中文原生名 13/13 全是恒等条目
      expect(cjkNativeInIndex.length).toBe(cjkNative.length); // 且 13/13 在函数索引里有 @ 定义
      expect(asciiBoth.length).toBeGreaterThan(440);
      expect(asciiEchoBoth.length).toBe(0); // ASCII 侧全是真翻译 ⇒ "索引一律优先"会打沉这一半

      const summary = {
        分母: { files: files.length, atDefLines, functions: allDefs.length, cjkNames: cjkDefs.length, share: `${(cjkShare * 100).toFixed(2)}%` },
        定义名点位: { n: defPoints.length, 改前: defArms.beforeHit, 改后: defArms.afterHit, 改前率: `${((defArms.beforeHit / defPoints.length) * 100).toFixed(2)}%`, 改后率: `${((defArms.afterHit / defPoints.length) * 100).toFixed(2)}%` },
        CALL槽: { n: callArms.afterToken, 改前: callArms.beforeHit, 改后: callArms.afterHit },
        提及点: { n: mentionArms.afterToken, 改前: mentionArms.beforeHit, 改后: mentionArms.afterHit },
        端到端抽样: { n: sampled.length, 改前: e2eBefore, 改后: e2eAfter },
        散文点位: {
          n: prosePoints.length,
          改前可跳: proseArms.beforeHit,
          改后可跳: proseArms.afterHit,
          新增: newJumps,
          改前率: `${(proseBeforeShare * 100).toFixed(3)}%`,
          改后率: `${(proseAfterShare * 100).toFixed(3)}%`,
          冒号退让挡掉: colonBlocked,
        },
        库表: { 条目: entries.length, 中文原生名: cjkNative.length, 恒等: echoCjkNative.length, 在索引: cjkNativeInIndex.length, ASCII同现索引: asciiBoth.length, ASCII恒等: asciiEchoBoth.length, 系统表中文键: [...SYSTEM_FUNCTION_REVERSE.keys()].filter((k) => HAS_CJK.test(k)).length },
      };
      console.log('F12-A-B ' + JSON.stringify(summary, null, 1));
    },
  );
});

// 反向钉：`visibleCodeLines` 的可见行口径本批一字未动（散文点位那一臂与它无关，用它只钉"没被改过"）
describe('F12 记号尺 · 未动的邻接判据', () => {
  it.skipIf(!SMOKE)('语料里 `@` 定义行的名字点位：记号整串 == 定义名（除含集外字符者）', () => {
    const root = path.join(SMOKE!, 'ERB');
    let checked = 0;
    let skipped = 0;
    for (const p of dialectFiles(root).slice(0, 400)) {
      const text = readFileSync(p, 'utf8');
      const file = parseErbText(text, p);
      for (const fn of file.functions) {
        if (!HAS_CJK.test(fn.name)) continue;
        const lineText = linesOf(text)[fn.startLine - 1] ?? '';
        const start = fn.nameColumn ?? lineText.indexOf(fn.name) + 1;
        if (start < 1) continue;
        const tok = functionNameTokenAt(lineText, start);
        if (tok === undefined) {
          skipped++; // 名字含 `MODEL_TOKEN_CLASS` 集外字符（如全角 `＿`）——既有口径，本批不动
          continue;
        }
        if (tok.text.toUpperCase() === fn.normalizedName) checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(skipped).toBeLessThan(checked); // 绝大多数中文名换尺后取回的就是定义名整串
  });
});
