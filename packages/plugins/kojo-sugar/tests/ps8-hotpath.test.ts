/**
 * PS-8（糖热路径批）· 确定性等价/状态卫生网（**不测墙钟**，全部逐值断言，默认并行池）。
 *
 * 覆盖四条改动：
 * 1. `lexer` 动态正则记忆化（wordTail / 循环头 / 步进 / `stripCont` / `续` 引号检测）：
 *    记忆实例跨行共享 ⇒ 最怕 `g` 旗标的 `lastIndex` 泄漏——用"多命中行 → 更短行 → 再命中行"
 *    的诊断逐值对照把这条钉死；词首扫描组另用同料三连打的全等断言钉住稳定性；
 * 2. `column-map.sourceMapIndex.exact` 与 `Array.prototype.find` 的**首条匹配**同语义
 *    （含重复 `generatedLine` 的畸形表）；
 * 3. `langsvc.foldGeneratedLine` 索引版（二分 + 前扫）与改前全量扫描版**逐行 parity**
 *    （含 `@` 头截断、null 源行跳过、表尾之外查询）；
 * 4. `codegen.buildAutoIndexPools` 的 `^@` 前缀闸 + 头正则缓存：占号产物经真实服务出口对拍不变。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic, SugarSourceMapEntry, SugarTranspileResult } from '@kojo/plugin-api';
import { classifyLine, splitLogicalLines, stripCont } from '../src/lexer';
import type { DiagnosticSink } from '../src/types';
import { sourceMapIndex } from '../src/column-map';
import { foldGeneratedLine } from '../src/langsvc';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

/* ============================== 1. lexer 正则记忆化 ============================== */

function makeSink(): { sink: DiagnosticSink; diags: SugarDiagnostic[] } {
  const diags: SugarDiagnostic[] = [];
  return {
    diags,
    sink: {
      report(d: SugarDiagnostic): void {
        diags.push(d);
      },
      all: () => diags,
    },
  };
}

describe('PS-8 · lexer 动态正则记忆化：状态卫生', () => {
  it('`续` 引号检测共享带 `g` 旗标的实例：诊断逐列正确、跨调用不留 lastIndex 残态', () => {
    const { sink, diags } = makeSink();
    const lines = splitLogicalLines('「第一续出现」与「第二续出现」\n正常台词一行\n「再来一处续」');
    stripCont(lines[0]!.text, sink, lines[0]!);
    stripCont(lines[1]!.text, sink, lines[1]!); // 中间夹一行**无命中**——复位缺失时后一行会被残 lastIndex 吃掉
    stripCont(lines[2]!.text, sink, lines[2]!);
    const hits = diags.filter((d) => d.code === 'cont-inside-quotes');
    expect(hits.map((d) => `${d.loc?.line}:${d.loc?.column}`)).toEqual(['1:1', '1:9', '3:1']);
  });

  it('wordTail / 循环头 / 步进 / 条目正则记忆后逐调稳定（同料三连打输出全等 + 判据抽样钉住）', () => {
    const probes = [
      '跳到 标签甲',
      '标签 乙',
      '步进 I 加 1',
      '步进 CFLAG:3 减 2',
      '循环 计数 I 从 0 到 5：',
      '循环 计数 I 从 0 到 5 步长 2：',
      '循环 当 LOCAL:1 = 0：',
      '循环结束 当 LOCAL:1 = 0',
      '条目 DATAFORM 文本',
      '条目 原形 DATA X',
      '数据表 原形 PRINTDATAV',
      '跳到',
      '步进 I 乘 1',
    ];
    const lines = splitLogicalLines(probes.join('\n'));
    const round = (): unknown[] => lines.map((l) => classifyLine(l));
    const a = round();
    expect(round()).toEqual(a);
    expect(round()).toEqual(a);
    // 记忆化改的是"怎么建正则"，不是"匹配什么"——判据本身抽样钉住
    expect(a[0]).toMatchObject({ kind: 'jumpStatement', engine: 'GOTO', target: '标签甲' });
    expect(a[1]).toMatchObject({ kind: 'labelDecl', name: '乙' });
    expect(a[2]).toMatchObject({ kind: 'loopStep', name: 'I', sign: '+', delta: '1' });
    expect((a[4] as { kind: string }).kind).toBe('loopHead');
    expect((a[5] as { kind: string }).kind).toBe('loopHead');
    expect(a[6]).toMatchObject({ kind: 'loopHead', loop: { mode: 'when', condition: 'LOCAL:1 = 0' } });
    expect(a[7]).toMatchObject({ kind: 'loopEnd', condition: 'LOCAL:1 = 0' });
    expect((a[11] as { kind: string }).kind).toBe('controlMalformed');
    expect((a[12] as { kind: string }).kind).toBe('controlMalformed');
  });
});

/* ============================== 2. sourceMapIndex.exact ≡ find ============================== */

type Entry = [generatedLine: number, sourceLine: number | null];

function fakeResult(lines: string[], entries: readonly Entry[]): SugarTranspileResult {
  const sourceMap: SugarSourceMapEntry[] = entries.map(([generatedLine, sourceLine]) => ({
    generatedLine,
    sourceLine,
  }));
  return { erb: lines.join('\n'), sourceMap, diagnostics: [] } as unknown as SugarTranspileResult;
}

describe('PS-8 · sourceMapIndex 与 find/排序同语义', () => {
  it('重复 generatedLine 取首条；缺失行给 undefined；同一结果对象复用同一索引', () => {
    const result = fakeResult(
      ['@A', 'body', 'body2', '@B'],
      [
        [2, 20],
        [2, 99], // 重复键：find 取首条
        [3, null],
        [4, 40],
      ],
    );
    const index = sourceMapIndex(result);
    for (const g of [2, 3, 4, 1, 7]) {
      expect(index.exact.get(g)).toBe(result.sourceMap.find((x) => x.generatedLine === g));
    }
    expect(index.ordered.map((x) => `${x.generatedLine}:${x.sourceLine}`)).toEqual(
      [...result.sourceMap]
        .sort((a, b) => a.generatedLine - b.generatedLine)
        .map((x) => `${x.generatedLine}:${x.sourceLine}`),
    );
    expect(sourceMapIndex(result)).toBe(index); // WeakMap 记忆：同一结果 ⇒ 同一索引
  });
});

/* ============================== 3. foldGeneratedLine 逐行 parity ============================== */

/** 改前实现（逐字镜像：每次全量 split + sort + 线性扫） */
function legacyFold(result: SugarTranspileResult, generatedLine: number): number | null {
  const exact = result.sourceMap.find((e) => e.generatedLine === generatedLine);
  if (exact?.sourceLine != null) return exact.sourceLine;
  const lines = result.erb.split('\n');
  const ordered = [...result.sourceMap].sort((a, b) => a.generatedLine - b.generatedLine);
  for (const entry of ordered) {
    if (entry.generatedLine <= generatedLine) continue;
    if (/^@/.test(lines[entry.generatedLine - 1] ?? '')) return null;
    if (entry.sourceLine !== null) return entry.sourceLine;
  }
  return null;
}

describe('PS-8 · foldGeneratedLine 索引版与全量扫版逐行一致', () => {
  it('3,000 行合成产物（含 @ 头 / 纯生成 null 行 / 表尾之外查询）：每一行两版全等', () => {
    const n = 3000;
    const lines: string[] = [];
    const entries: Entry[] = [];
    for (let g = 1; g <= n; g++) {
      if (g % 97 === 0) {
        lines.push(`@GENERATED_HEAD_${g}`);
        entries.push([g, null]); // 纯生成头：向下折一撞上 `@` 头 ⇒ null
      } else if (g % 13 === 0) {
        lines.push('\tRETURN 1');
        entries.push([g, null]); // 体内生成行：向下找最近有源行
      } else {
        lines.push(`\tPRINTFORMW x${g}`);
        entries.push([g, g]);
      }
    }
    const result = fakeResult(lines, entries);
    for (let g = 1; g <= n + 50; g++) {
      expect(foldGeneratedLine(result, g), `generatedLine=${g}`).toBe(legacyFold(result, g));
    }
  });
});

/* ============================== 4. autoIndex 前缀闸 + 头正则缓存 ============================== */

describe('PS-8 · 占号白扫前缀闸：占号产物经真实服务出口不变', () => {
  it('原生块占 7 + 显式编号占 9 + 两枚省略编号 ⇒ 1 / 2，且重复转译逐字节相等', () => {
    const svc = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
    const source =
      '角色: 12\n' +
      '时机 事件：\n    「甲」\n' +
      '时机 事件：\n    「乙」\n' +
      '时机 事件 9：\n    「九」\n' +
      '@M_KOJO_EVENT_K12_7(ARG)\n' +
      '\tRETURN 0\n';
    const heads = (erb: string) => erb.split('\n').filter((l) => l.startsWith('@'));
    const a = svc.transpile(source);
    expect(heads(a.erb)).toContain('@M_KOJO_EVENT_K12_1');
    expect(heads(a.erb)).toContain('@M_KOJO_EVENT_K12_2');
    expect(heads(a.erb)).toContain('@M_KOJO_EVENT_K12_7(ARG)'); // 原生块逐字透传
    // 第二个**独立服务实例**（自带转译缓存 ⇒ 真实重跑整条管线）：正则缓存热了之后重扫占号，
    // 前缀闸若筛错行，这里就会给出不同的号
    const svc2 = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
    const b = svc2.transpile(source);
    expect(b.erb).toBe(a.erb);
  });
});
