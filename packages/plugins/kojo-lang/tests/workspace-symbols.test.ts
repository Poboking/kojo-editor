/**
 * `workspaceSymbol` 供方（ERB-PARITY G4，2026-10-31）——`Ctrl+T` 的 2.0 符号。
 *
 * ## 取证方式
 *
 * 全内存夹具：请求里塞 `projectFiles`（宿主那一侧的原样形状），供方用
 * `@kojo/kojo-lang/symbols` 的同一份纯函数摊符号。零真实语料、零读盘、零 Monaco。
 *
 * 钉六件事：
 * 1. **弃权 vs 作答**：非 workspaceSymbol / 没有快照 / 快照里没有 2.0 源 ⇒ `undefined`
 *    （弃权）；空查询 ⇒ 空作答（`{symbols: [], totalMatched: 0}`）；
 * 2. **命中口径**：名字（大小写不敏感子串）+ 路径两段，名字已命中的文件不重复按路径展开；
 * 3. **候选形状**：`kind` 走与大纲**同一张**映射表、行/列取 `selectionRange` 起点、
 *    `detail` 原样带出；
 * 4. **预算**：`limit` 截断产出但 `totalMatched` 照常报（"另有 N 条"不是编的）；
 * 5. **范围由宿主兜**：本供方不看范围戳（`scope` 不是工作区符号请求的一格）——宿主在
 *    `collectWorkspaceSymbols` 里按同一条 `pathInScope` 过滤；
 * 6. **缓存不改答案**：同一路径换文本必须重算（否则 `Ctrl+T` 会读到上一版符号）。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceRequest, EditorProjectFile } from '@kojo/plugin-api';
import { provideWorkspaceSymbols } from '../src/workspace-symbols';

const A_KOJO = [
  '# 幕 神社清晨',
  '# 设 亲近线 整数 = 500',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 数值',
].join('\n');

const B_KOJO = ['@函 打招呼', '    > 「早上好。」'].join('\n');

const C_ERB = ['@SOMETHING', '  PRINTL "hi"'].join('\n');

const FILES: readonly EditorProjectFile[] = [
  { path: 'C:/p/a.kojo', text: A_KOJO },
  { path: 'C:/p/b.kojo', text: B_KOJO },
  { path: 'C:/p/c.erb', text: C_ERB },
];

function request(
  query: string,
  patch: Partial<EditorLanguageServiceRequest> = {},
): EditorLanguageServiceRequest {
  return {
    kind: 'workspaceSymbol',
    query,
    project: null,
    projectFiles: FILES,
    projectFilesComplete: true,
    ...patch,
  } as EditorLanguageServiceRequest;
}

describe('kojo2 workspaceSymbol · 三态', () => {
  it('不是 workspaceSymbol 请求 ⇒ 弃权（undefined）', () => {
    expect(
      provideWorkspaceSymbols({ kind: 'documentSymbol', path: 'C:/p/a.kojo', text: A_KOJO } as never),
    ).toBeUndefined();
  });

  it('没有项目文件快照 ⇒ 弃权（不把"还没名录"答成"没有匹配"）', () => {
    expect(provideWorkspaceSymbols(request('增加', { projectFiles: undefined }))).toBeUndefined();
  });

  it('快照里一枚 2.0 源都没有 ⇒ 弃权（纯 ERB 项目里这条腿不抢答）', () => {
    expect(
      provideWorkspaceSymbols(request('SOMETHING', { projectFiles: [{ path: 'C:/p/c.erb', text: C_ERB }] })),
    ).toBeUndefined();
  });

  it('认这个查询但一条没命中 ⇒ 空作答（不是弃权）', () => {
    expect(provideWorkspaceSymbols(request('不存在的名字'))).toEqual({
      kind: 'workspaceSymbol',
      symbols: [],
      totalMatched: 0,
    });
  });

  it('空 / 全空白查询 ⇒ 空作答（先打字再出项，与 ERB 腿同一条）', () => {
    expect(provideWorkspaceSymbols(request('   '))).toEqual({
      kind: 'workspaceSymbol',
      symbols: [],
      totalMatched: 0,
    });
  });
});

describe('kojo2 workspaceSymbol · 命中与形状', () => {
  it('中文名子串命中：候选带契约中性类别、`selectionRange` 起点行列、声明 detail', () => {
    const out = provideWorkspaceSymbols(request('羁绊'));
    expect(out).toBeDefined();
    expect(out!.symbols).toHaveLength(1);
    expect(out!.symbols[0]).toMatchObject({
      name: '增加羁绊',
      kind: 'function',
      filePath: 'C:/p/a.kojo',
      line: 3,
      column: 4, // `@函 ` 之后（1 基，UTF-16 码元）
      detail: '函 (目标, 数值 = 10)',
    });
    expect(out!.totalMatched).toBe(1);
  });

  it('大小写不敏感：小写查询命中原生大写名（与 ERB 的归一化口径同形）', () => {
    const source = ['# 设 HP 整数 = 100', '# 设 hp上限 整数 = 999'].join('\n');
    const files = [{ path: 'C:/p/stats.kojo', text: source }];
    const out = provideWorkspaceSymbols(request('hp', { projectFiles: files }));
    expect(out!.symbols.map((s) => s.name).sort()).toEqual(['HP', 'hp上限']);
  });

  it('路径命中：名字没命中但文件名命中 ⇒ 该文件里的符号全在结果里，且不重复计数', () => {
    const out = provideWorkspaceSymbols(request('b.kojo'));
    expect(out).toBeDefined();
    expect(out!.symbols.map((s) => s.name)).toEqual(['打招呼']);
    expect(out!.totalMatched).toBe(1);
    // 名字命中与路径命中互斥：`打招呼` 不会因为文件也命中而被再记一次
    expect(new Set(out!.symbols.map((s) => `${s.filePath}:${s.line}:${s.name}`)).size).toBe(1);
  });

  it('`kind` 与文档大纲同一张映射表（幕 = section、设 = declaration、函 = function）', () => {
    const out = provideWorkspaceSymbols(request('ke', { projectFiles: [] })); // 无源 ⇒ 弃权
    expect(out).toBeUndefined();
    const all = provideWorkspaceSymbols(request('神社')); // 幕名
    expect(all!.symbols[0]).toMatchObject({ name: '神社清晨', kind: 'section' });
    const decl = provideWorkspaceSymbols(request('亲近线'));
    expect(decl!.symbols[0]).toMatchObject({ name: '亲近线', kind: 'declaration' });
  });

  it('同输入两次逐字相等（顺序确定：桶序 + 源码序，不随文件喂入顺序漂）', () => {
    const first = provideWorkspaceSymbols(request('a'));
    const second = provideWorkspaceSymbols(request('a'));
    expect(second).toEqual(first);
    const reversed = provideWorkspaceSymbols(
      request('a', { projectFiles: [...FILES].reverse() }),
    );
    expect(reversed!.symbols).toEqual(first!.symbols);
  });
});

describe('kojo2 workspaceSymbol · 预算与截断', () => {
  it('`limit` 截断产出，但 `totalMatched` 照常报（"另有 N 条"不是编的）', () => {
    const source = ['# 设 测试甲 整数', '# 设 测试乙 整数', '# 设 测试丙 整数', '# 设 测试丁 整数'].join('\n');
    const out = provideWorkspaceSymbols(
      request('测试', { projectFiles: [{ path: 'C:/p/many.kojo', text: source }], limit: 1 }),
    );
    // `candidateBudget('providerQuery', 1)` 至少给 1 条；总命中必须是 4（含被预算挡掉的）
    expect(out!.symbols.length).toBeLessThanOrEqual(1);
    expect(out!.totalMatched).toBe(4);
  });

  it('快照不完整仍照答（数量是"看得到的下界"，不把没看到的说成没有）', () => {
    const out = provideWorkspaceSymbols(request('增加', { projectFilesComplete: false }));
    expect(out!.symbols).toHaveLength(1);
  });
});

describe('kojo2 workspaceSymbol · 缓存', () => {
  it('同一路径换文本必须重算（缓存按文本逐字比对，不是按路径盲命中）', () => {
    const files = [{ path: 'C:/p/live.kojo', text: '# 设 旧名 整数 = 1' }];
    const before = provideWorkspaceSymbols(request('旧名', { projectFiles: files }));
    expect(before!.symbols.map((s) => s.name)).toEqual(['旧名']);
    const after = provideWorkspaceSymbols(
      request('旧名', { projectFiles: [{ path: 'C:/p/live.kojo', text: '# 设 新名 整数 = 1' }] }),
    );
    expect(after!.symbols).toEqual([]);
    const renamed = provideWorkspaceSymbols(
      request('新名', { projectFiles: [{ path: 'C:/p/live.kojo', text: '# 设 新名 整数 = 1' }] }),
    );
    expect(renamed!.symbols.map((s) => s.name)).toEqual(['新名']);
  });
});