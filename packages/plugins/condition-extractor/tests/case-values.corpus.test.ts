/**
 * CASE 值列表 · 真实语料对账闸（W8-C2：CASE 纳入 `{`…`}` 行连接）。
 *
 * 守门：`KOJO_SMOKE_PROJECT`（语料解析见 `tools/corpus.mjs`；**测试只读 env，不写死路径**）。
 *
 * 取证结论（引擎源码 `MinorShift.Emuera.Sub/EraStreamReader.cs:96 ReadEnabledLine`）：
 * 行連結的唯一机制是孤行 `{` 起、孤行 `}` 止——**没有**「行尾 `,` ⇒ 连下一行」。
 * 据此：
 * - 真正的多行 CASE 值列表全部在 `{`…`}` 块内，按 `{` 门收 ⇒ 值片段**净增**（取证预估 +307 量级）；
 * - 非块的尾逗号 CASE（`CASE [[跳蛋]],` 下一行是内层 SELECTCASE 等 7 处）必须保持不拼
 *   ——按尾逗号拼会把内层 SELECTCASE 吃成值片段、凭空多出假谓词（PITFALLS 记过反噬）。
 *
 * 本闸钉住三条不变量（读数真实打印）：
 * 1. 谓词总数增量 = CASE 值片段增量（IF 族拼接不改谓词数，增量只能来自 CASE 值）；
 * 2. opaque 计数拼接后**不升**（拼接只补全原文，绝不把语句吃成假谓词）；
 * 3. 增量为正且量级与取证同源（样本只打印不判，绝对值随语料漂移）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseErbText, scanControlFlow } from '@kojo/plugin-erb-parser';
import { collectPredicates } from '../src/extract';
import { decodeWithProbe } from '../../../kernel/src/encoding';

/** 递归收集 `.ERB`（不跟随符号链接），按路径码点序排序。 */
function collectErbFiles(root: string): string[] {
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
      else if (ent.isFile() && /\.erb$/i.test(ent.name)) out.push(p);
    }
  }
  out.sort();
  return out;
}

describe.skipIf(!process.env.KOJO_SMOKE_PROJECT)('CASE 值列表 · 真实语料对账闸（W8-C2）', () => {
  it('全语料：谓词增量 = CASE 值片段增量；opaque 不升；读数与样本打印', () => {
    const root = process.env.KOJO_SMOKE_PROJECT!;
    const files = collectErbFiles(root);
    expect(files.length).toBeGreaterThan(0);

    let predicates = 0;
    let predicatesWithout = 0;
    let caseFragments = 0;
    let caseFragmentsWithout = 0;
    let opaque = 0;
    let opaqueWithout = 0;
    const samples: string[] = [];

    for (const file of files) {
      const { text } = decodeWithProbe(readFileSync(file));
      const rel = relative(root, file).replaceAll('\\', '/');
      const stmts = scanControlFlow(text);
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const { functions } = parseErbText(text, rel);

      // 两指针切片：stmts 与 functions 均按行号升序（与 offload.extractFileBucket 同口径）
      let cursor = 0;
      for (const fn of functions) {
        while (cursor < stmts.length && stmts[cursor]!.line < fn.startLine) cursor++;
        const slice = [];
        for (let j = cursor; j < stmts.length && stmts[j]!.line <= fn.endLine; j++) slice.push(stmts[j]!);
        if (slice.length === 0) continue;

        const withLines = collectPredicates(slice, { lines });
        const withoutLines = collectPredicates(slice);
        predicates += withLines.length;
        predicatesWithout += withoutLines.length;
        opaque += withLines.filter((p) => p.expr.kind === 'opaque').length;
        opaqueWithout += withoutLines.filter((p) => p.expr.kind === 'opaque').length;
        caseFragments += withLines.filter((p) => p.kind === 'CASE').length;
        caseFragmentsWithout += withoutLines.filter((p) => p.kind === 'CASE').length;

        // 单条 CASE 的增量样本（文件名:行号；语料绝对路径严禁出现在任何提交文件里）
        for (const s of slice) {
          if (s.kind !== 'CASE') continue;
          const joined = collectPredicates([s], { lines }).length;
          const head = collectPredicates([s]).length;
          if (joined > head && samples.length < 12) samples.push(`${rel}:${s.line} +${joined - head} 值片段`);
        }
      }
    }

    const delta = predicates - predicatesWithout;
    const caseDelta = caseFragments - caseFragmentsWithout;
    console.log(
      `[case-values] ${files.length} 份 .ERB：谓词 ${predicates}（不拼口径 ${predicatesWithout} ⇒ 净增 +${delta}）｜ ` +
        `CASE 值片段 ${caseFragments}（不拼口径 ${caseFragmentsWithout} ⇒ 净增 +${caseDelta}）｜ ` +
        `opaque 拼后 ${opaque} / 拼前 ${opaqueWithout}`,
    );
    console.log(`[case-values] 值片段增量样本：\n${samples.map((s) => `  ${s}`).join('\n') || '  （无）'}`);

    // ① 谓词增量只能来自 CASE 值片段（IF 族拼接不改谓词数）
    expect(delta).toBe(caseDelta);
    expect(caseDelta, '块内 CASE 列表必须在真语料上净增值片段（取证 +307 量级）').toBeGreaterThan(0);
    // ② opaque 不升：拼接只补全原文，绝不把语句吃成假谓词
    expect(opaque, '拼接后 opaque 计数不得上升（尾逗号拼行的反噬形态）').toBeLessThanOrEqual(opaqueWithout);
  }, 600_000);
});
