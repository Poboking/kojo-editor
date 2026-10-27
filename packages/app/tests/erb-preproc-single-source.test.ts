/**
 * ERB 预处理器标记 `[IF…]`/`[ELSE]`/`[ENDIF]`：**四处消费面 == 一份契约真源** 的跨面对拍（lead 名下）。
 *
 * 本批的根因不是"少涂一档颜色"，而是同一份语言事实此前落了三处、第四处（显示层）从来没写：
 * `erb-parser/src/structure.ts` 的三枚正则、`erb-syntax-tree/src/index.ts` 的三枚同名正则、
 * Monarch 根本没有。契约 §一把它收进 `@kojo/plugin-api` 的 `ERB_PREPROC_PATTERNS`，
 * 三处消费方全部改为派生。本文件钉的就是"派生"这件事本身——**任一处再手写一份或判据漂开，这里就红**：
 *
 * 1. 契约真源 `erbPreprocRoleOf`
 * 2. 结构体检侧 `@kojo/plugin-erb-parser` 的 `preprocRoleOf`（委托真源）
 * 3. 语法包侧的构建期投影产物 `structure.json` 的 `preproc` 段（文法不吃运行期 import，走投影）
 * 4. 显示侧：真 Monarch 编译后**是否**发预处理器档（`erb-highlight.test.ts` 同一基座）
 *
 * 判定方向是双向的：正例四处都认、反例四处都不认——只断"认的集合相等"会放过"两边一起漏"。
 */
import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { ERB_PREPROC_PATTERNS, ERB_SKIP_MARKERS, erbPreprocRoleOf } from '@kojo/plugin-api';
import { preprocRoleOf as parserRoleOf } from '@kojo/plugin-erb-parser';
// 折叠面的字形镜像（`FOLD_PREPROC_PATTERNS`）：`erb-parser/src/folding.ts` 被
// `tools/fold-compare.mjs` 以裸 node 直读，值导入 `@kojo/plugin-api` 桶会连带 `io.ts`
// 的参数属性语法把工具打死（PITFALLS §151），所以那一侧按既定纪律放一份镜像而非 import 真源。
// 镜像的存在意味着它必须由**本文件**这种外部对拍钉住——第五处消费面，别让它成为第六份漂移。
import { FOLD_PREPROC_PATTERNS, foldPreprocRoleOf } from '../../plugins/erb-parser/src/folding';
import { registerErbLanguage } from '../src/monaco/erb-language';
import { registerKojoLanguage } from '../src/monaco/kojo-language';
import { ROLE } from '@kojo/kojo-lang/semantic-roles';
import { compileMonarch, driveLexer, stubMonaco, type CompiledLexer } from './monarch-harness';
import structure from '../../erb-syntax-tree/src/structure.json' with { type: 'json' };

const ERB_ID = 'kojo-erb';
const { monaco, captured } = stubMonaco();
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

function erbLexer(): Promise<CompiledLexer> {
  const def = captured.monarchs.get(ERB_ID);
  if (!def) throw new Error(`monaco 桩没捕获到 ${ERB_ID} 的 Monarch def（装配面漂 = 本文件整个红）`);
  return compileMonarch(ERB_ID, def as Monaco.languages.IMonarchLanguage);
}

/** 语法包侧的角色：按投影产物重建正则（与 `erb-syntax-tree/src/index.ts` 同一份 structure.json） */
function projectedRoleOf(lineText: string): 'open' | 'branch' | 'close' | null {
  const pre = (structure as { preproc?: Record<string, string> }).preproc;
  if (!pre) throw new Error('structure.json 缺 preproc 段——构建期投影没跑（重跑 `node packages/erb-syntax-tree/tools/gen-erb-structure.mjs`）');
  const text = lineText.trim();
  for (const role of ['close', 'branch', 'open'] as const) {
    if (new RegExp(pre[role]!, pre.flags).test(text)) return role;
  }
  return null;
}

/** 判据样本：正例（含语料实测的三种大小写与空格形态）与反例（ASCII 画 / 残形 / 粘连词） */
const RECOGNIZED: readonly (readonly [string, 'open' | 'branch' | 'close'])[] = [
  ['[IF x]', 'open'],
  ['[IF DEBUG]', 'open'],
  ['[IF_DEBUG]', 'open'],
  ['[IF_NDEBUG]', 'open'],
  ['[if debug]', 'open'],
  ['[ELSEIF y > 1]', 'branch'],
  ['[ELSE]', 'branch'],
  ['[else]', 'branch'],
  ['[ENDIF]', 'close'],
  ['[endif]', 'close'],
  ['  [IF a]  ', 'open'], // 前导缩进 + 行尾空白
  ['\t[ENDIF]\t', 'close'],
];

const NOT_RECOGNIZED: readonly string[] = [
  '[ 1 2 3 ]', // ASCII 画的方括号行
  '[IF]', // 裸形：开块要带条件参数
  '[IF ]', // 只有空格
  '[ENDIF ]', // `]` 前有杂质
  '[ELSEIFFY]', // 粘连词
  ERB_SKIP_MARKERS.start, // 停用区标记不是条件块（另有专路）
  ERB_SKIP_MARKERS.end,
  '[MACRO]',
];

describe('预处理器 `[` 标记：四处消费面与契约真源同判（跨面对拍）', () => {
  for (const [line, role] of RECOGNIZED) {
    it(`「${JSON.stringify(line)}」四处都认成 ${role}`, async () => {
      const truth = erbPreprocRoleOf(line);
      expect(truth, '契约真源').toBe(role);
      expect(parserRoleOf(line), '结构体检侧').toBe(truth);
      expect(foldPreprocRoleOf(line), '折叠侧（镜像）').toBe(truth);
      expect(projectedRoleOf(line), '语法包投影侧').toBe(truth);
      const emitted = driveLexer(await erbLexer(), line);
      expect(
        emitted.some((e) => e.token.startsWith(ROLE.directive)),
        `显示侧实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`,
      ).toBe(true);
    });
  }

  for (const line of NOT_RECOGNIZED) {
    it(`「${JSON.stringify(line)}」四处都不认（反例双向，防"两边一起漏"）`, async () => {
      const truth = erbPreprocRoleOf(line);
      expect(truth, '契约真源').toBeNull();
      expect(parserRoleOf(line), '结构体检侧').toBeNull();
      expect(projectedRoleOf(line), '语法包投影侧').toBeNull();
      const emitted = driveLexer(await erbLexer(), line);
      // 停用区标记走**另一条专路**（`[SKIPSTART]`/`[SKIPEND]` 的块状态）——LAU-2 收口后它与
      // 条件块标记落同一角色 `role.directive`（同一枚色），故这里只能钉"它确实着色了"，
      // "不是条件块"由上面三条契约面对拍负责；其余反例则连该角色的发射都不许有。
      const skipMarker = line === ERB_SKIP_MARKERS.start || line === ERB_SKIP_MARKERS.end;
      expect(
        emitted.some((e) => e.token.startsWith(ROLE.directive)),
        `显示侧实发 ${emitted.map((e) => `${e.text}=${e.token}`).join(' / ')}`,
      ).toBe(skipMarker);
    });
  }
});

describe('投影产物 == 契约真源（逐字节，不是"行为相似"）', () => {
  const pre = (structure as { preproc?: Record<string, string> }).preproc!;
  for (const role of ['open', 'branch', 'close'] as const) {
    it(`structure.json 的 preproc.${role} 逐字等于真源 pattern.source`, () => {
      expect(pre[role]).toBe(ERB_PREPROC_PATTERNS[role].source);
    });
    it(`折叠侧镜像 FOLD_PREPROC_PATTERNS.${role} 逐字等于真源（镜像只许逐字，不许"近似"）`, () => {
      expect((FOLD_PREPROC_PATTERNS[role] as RegExp).source).toBe(ERB_PREPROC_PATTERNS[role].source);
      expect((FOLD_PREPROC_PATTERNS[role] as RegExp).flags).toBe(ERB_PREPROC_PATTERNS[role].flags);
    });
  }
  it('标志同一枚（`i` 且无 `g`/`y`——带全局标志的 `test()` 有状态，共享即错）', () => {
    expect(pre.flags).toBe(ERB_PREPROC_PATTERNS.open.flags);
    expect(pre.flags).toContain('i');
    for (const role of ['open', 'branch', 'close'] as const) {
      expect(ERB_PREPROC_PATTERNS[role].flags).not.toMatch(/[gy]/);
    }
  });
});
