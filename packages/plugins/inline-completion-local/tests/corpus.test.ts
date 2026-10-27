import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ErbFile, ErbIndex, InlineCompletionRequest } from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { aggregateIndex, parseErbText } from '../../erb-parser/src/index';
import { decodeWithProbe } from '../../../kernel/src/encoding';
import { declaredCatalog, functionCatalog } from '../src/catalog';
import { erbNameSlotAt } from '../src/slot-shape';
import { localInlineCompletion } from '../src/provider';

/**
 * 真语料活闸（B 线 · IC 批）：在**盘上的真 ERB** 上把本地候选器跑一遍，报命中率。
 *
 * 形态照本仓既有 corpus 钉子（`condition-extractor/tests/case-values.corpus.test.ts` 一路）：
 * - **只读 env**（`KOJO_SMOKE_PROJECT`，路径解析见 `tools/corpus.mjs`）——语料目录名会被反复
 *   重排，把路径写进仓库必然过期；语料不在位时**整组 SKIP**，不挂空串让 setup 全崩；
 * - 判据是**三条不变量**而不是某个绝对数（绝对数随语料漂移，只打印）：
 *   ①规模不为 0（真的问了成千上万格）；
 *   ②每一枚给出者都可解释（**独立**前缀计数 == 1 —— 计数表由"逐名展开前缀"另建一份，
 *   不吃本包那套二分，所以不是拿自己的输出当自己的依据）；
 *   ③被拒者一律没进结果（凡独立计数 ≥2 的前缀，`state` 必是 `no-completion`）。
 *
 * 取样协议（为什么这样构造光标）：拿解析器交出的**事实**（`@` 定义名的行与列、`#DIM` 声明名、
 * `CALL` 首槽）当"作者已经写下的名字"，在每枚名字的**中间**与**末尾**各放一次光标 ——
 * 这两档正是幽灵文本真实面对的两种时刻（写到一半 / 刚写完）。
 * 跑的是 `localInlineCompletion` 本体，不是它的复刻：读数与线上行为同源。
 *
 * 与本包判据同源但**不独立**的一处：取样点用正则 `^\s*(CALL|TRYCALL|TRYCCALL)\b` 找调用位，
 * 与本包的词表一致。这是**刻意的**（语料闸要量的是"名字命中规模"，不是"位置判据对不对"——
 * 后者由 `slot-shape.test.ts` 用夹具逐条钉）。词表若漂移，本闸与包会一起红，不会一边绿一边红。
 */

/** 取样文件数上限（整盘 3,818 份会把这一闸拖到分钟级；900 份足够让三条不变量有意义） */
const FILE_CAP = 900;

function collectDialectFiles(root: string): string[] {
  const stack = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && isErbDialectPath(ent.name)) out.push(p);
    }
  }
  out.sort();
  return out;
}

/** 一个取样点：某文件的某一行、该行原文、0 基光标下标 */
interface Probe {
  readonly file: string;
  readonly line: number;
  readonly lineText: string;
  readonly cursor: number;
}

/** 独立前缀计数表：把每枚名字的**所有前缀**展开成一张哈希表（与二分组法无关的第二算法） */
function buildPrefixCounts(catalog: { readonly names: readonly string[] }): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of catalog.names) {
    const upper = name.toUpperCase();
    for (let len = 1; len <= upper.length; len++) {
      const prefix = upper.slice(0, len);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return counts;
}

describe.skipIf(!process.env.KOJO_SMOKE_PROJECT)(
  '本地候选源 · 真语料命中率活闸（IC-B）',
  () => {
    it('盘上 ERB：三条不变量 + 命中率读数', () => {
      const root = process.env.KOJO_SMOKE_PROJECT!;
      const allFiles = collectDialectFiles(root);
      expect(allFiles.length, `语料根下没有方言文件？${root}`).toBeGreaterThan(0);
      const files = allFiles.slice(0, FILE_CAP);

      // —— 读盘 + 解析（只走 erb-parser 的既有纯函数；本包不参与"哪些名字存在"） ——
      const rows: { readonly parsed: ErbFile; readonly lines: readonly string[] }[] = [];
      for (const path of files) {
        const { text } = decodeWithProbe(new Uint8Array(readFileSync(path)));
        rows.push({
          parsed: parseErbText(text, relative(root, path).replaceAll('\\', '/')),
          lines: text.replace(/\r\n?/g, '\n').split('\n'),
        });
      }
      const index: ErbIndex = aggregateIndex(rows.map((r) => r.parsed));
      expect(index.byName.size).toBeGreaterThan(0);
      expect(index.files.size).toBeGreaterThan(0);

      const functions = functionCatalog(index);
      const declared = declaredCatalog(index);
      const directives = new Set<string>();
      for (const f of index.files.values()) for (const d of f.dims) directives.add(d.directive);

      // —— 取样点 ——
      const probes: Probe[] = [];
      const pushCuts = (file: string, line: number, lineText: string, nameStart: number, name: string): void => {
        if (nameStart < 0 || name.length === 0) return;
        const cuts = new Set<number>([
          nameStart + Math.max(1, Math.floor(name.length / 2)),
          nameStart + name.length,
        ]);
        for (const cursor of cuts) {
          if (cursor < nameStart || cursor > lineText.length) continue;
          probes.push({ file, line, lineText, cursor });
        }
      };

      const callRe = /^\s*(?:;[!#];)?(CALL|TRYCALL|TRYCCALL)([ \t]+)([^\s,;(]+)/i;
      for (const { parsed: file, lines } of rows) {
        for (const fn of file.functions) {
          const lineText = lines[fn.startLine - 1];
          if (lineText === undefined) continue;
          const byColumn = (fn.nameColumn ?? 1) - 1;
          const at =
            lineText.slice(byColumn, byColumn + fn.name.length) === fn.name ? byColumn : lineText.indexOf(fn.name);
          pushCuts(file.path, fn.startLine, lineText, at, fn.name);
        }
        for (const dim of file.dims) {
          const lineText = lines[dim.line - 1];
          if (lineText === undefined) continue;
          pushCuts(file.path, dim.line, lineText, lineText.indexOf(dim.name), dim.name);
        }
        for (let i = 0; i < lines.length; i++) {
          const m = callRe.exec(lines[i]!);
          if (m === null) continue;
          const target = m[3]!;
          // 正则锚在行首 ⇒ 命中段末尾减掉目标长度就是目标的 0 基起点（不依赖 `m.index`）
          pushCuts(file.path, i + 1, lines[i]!, m[0].length - target.length, target);
        }
      }
      expect(probes.length).toBeGreaterThan(0);

      const functionCounts = buildPrefixCounts(functions);
      const declaredCounts = buildPrefixCounts(declared);

      let asked = 0;
      let given = 0;
      let givenMidway = 0;
      let givenAtEnd = 0;
      // 逐形状读数（"哪一类槽在真语料上真的能自证"，回执要点）
      const givenByShape = new Map<string, number>();
      const absentByShape = new Map<string, number>();
      const bump = (map: Map<string, number>, key: string): void => {
        map.set(key, (map.get(key) ?? 0) + 1);
      };
      let abstained = 0;
      let none = 0;
      let ambiguousRejected = 0;
      let absentRejected = 0;
      let failed = 0;
      let slotMisses = 0;
      const givenSamples: string[] = [];
      const rejectSamples: string[] = [];

      for (let i = 0; i < probes.length; i++) {
        const probe = probes[i]!;
        const request: InlineCompletionRequest = {
          path: join(root, probe.file),
          languageId: 'kojo-erb',
          version: i + 1,
          line: probe.line,
          column: probe.cursor + 1,
          lineText: probe.lineText,
          prefix: probe.lineText.slice(0, probe.cursor),
          suffix: probe.lineText.slice(probe.cursor),
          contextBefore: probe.lineText.slice(0, probe.cursor),
          contextAfter: probe.lineText.slice(probe.cursor),
          project: { rootDir: root, kojoPaths: [root], adapterId: 'corpus' } as never,
          triggerKind: 'auto',
          timeoutMs: 5_000,
        };
        asked++;
        const trace = localInlineCompletion(request, { currentIndex: () => index });
        const outcome = trace.outcome;
        if (outcome === undefined) {
          abstained++;
          continue;
        }
        if (outcome.state === 'failed') {
          failed++;
          continue;
        }
        // 取样协议自证：这些点本该全在名字槽里；判不下来的比例是读数（不是判据）
        const slot = erbNameSlotAt(request.prefix, request.suffix, directives);
        if (slot === null) {
          slotMisses++;
          continue;
        }
        const counts = slot.catalog === 'functions' ? functionCounts : declaredCounts;
        const independentHits = counts.get(slot.typed.toUpperCase()) ?? 0;

        if (outcome.state === 'candidates') {
          given++;
          bump(givenByShape, slot.shape);
          // 给出时刻的形状：光标在名字**末尾**（刚写完）还是**中间**（写到一半）——
          // 后者才是幽灵文本的主场，前者多半是"作者已经写对了、接受=无变化"
          if (probe.cursor === slot.end) givenAtEnd++;
          else givenMidway++;
          const candidate = outcome.candidates[0]!;
          // ②可解释：回带版本逐字相等 + 插入文本以已打字面开头 + **独立计数恰好 1 条**
          expect(outcome.version).toBe(request.version);
          expect(outcome.candidates).toHaveLength(1);
          expect(candidate.insertText.toUpperCase().startsWith(slot.typed.toUpperCase())).toBe(true);
          expect(slot.typed.length).toBeGreaterThan(0);
          expect(independentHits, `给出者必须唯一：${slot.typed}`).toBe(1);
          // 样本优先收"写到一半"那一档（`刚写完` 那档的给出多半是作者已经写对、接受=无变化，
          // 拿它当证据等于给自己脸上贴金）
          if (givenSamples.length < 8 && probe.cursor !== slot.end) {
            givenSamples.push(`${probe.file}:${String(probe.line)} 「${slot.typed}」→「${candidate.insertText}」`);
          }
          continue;
        }

        none++;
        if (independentHits >= 2) {
          ambiguousRejected++;
          if (rejectSamples.length < 8) {
            rejectSamples.push(
              `${probe.file}:${String(probe.line)} 「${slot.typed}」独立命中 ${String(independentHits)} 条 ⇒ 未给`,
            );
          }
        } else {
          absentRejected++;
          bump(absentByShape, slot.shape);
        }
        // ③被拒者一律没进结果：反证 = 这一格独立计数 ≥2 时，绝不可能走到 candidates 分支
        //（上面那条 `expect(independentHits).toBe(1)` 已经把它钉死；这里再钉方向）
        if (independentHits >= 2) expect(outcome.state, `多匹配不该给：${slot.typed}`).toBe('no-completion');
      }

      const rate = asked === 0 ? 0 : Math.round((given / asked) * 1000) / 10;
      const fmt = (map: Map<string, number>): string =>
        [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${String(v)}`).join(' ');
      console.info(
        `[IC-B 语料活闸] 根=${root} 文件=${String(files.length)}/${String(allFiles.length)} ` +
          `名字=${String(index.byName.size)} 声明名=${String(declared.keys.length)} ` +
          `指令=${[...directives].sort().join('/')} 取样=${String(probes.length)}\n` +
          `  探测=${String(asked)} · 给出=${String(given)}（${String(rate)}%）· 弃权=${String(abstained)} ` +
          `· 看过没给=${String(none)}（多匹配拒 ${String(ambiguousRejected)} / 名录无此名 ${String(absentRejected)}）` +
          `· 失败=${String(failed)} · 取样点未判位=${String(slotMisses)}\n` +
          `  给出时刻的形状：写到一半=${String(givenMidway)} / 刚写完=${String(givenAtEnd)}\n` +
          `  逐形状：给出 ${fmt(givenByShape)} · 名录无此名 ${fmt(absentByShape)}\n` +
          `  给出样本：\n    ${givenSamples.join('\n    ')}\n` +
          `  被拒样本：\n    ${rejectSamples.join('\n    ')}`,
      );

      // ①规模不为 0
      expect(given).toBeGreaterThan(0);
      expect(asked).toBeGreaterThan(1000);
      // 主场景不为 0：幽灵文本的价值在"写到一半就能补完"，只会在"已经写完"处出字等于没用
      expect(givenMidway).toBeGreaterThan(0);
      // ③被拒者那一档确实存在过（否则这条闸是空匹配）
      expect(ambiguousRejected).toBeGreaterThan(0);
      // 取样协议本身要成立：绝大多数取样点确实落在名字槽里
      expect(slotMisses).toBeLessThan(asked);
      // 失败态在"项目已开 + 名录已建"的语料语境里一条都不该出现（出现就是判据漏了）
      expect(failed).toBe(0);
    }, 240_000);
  },
);
