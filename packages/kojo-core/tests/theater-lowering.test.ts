/**
 * M1 theater lowering 独立验证（只读公共 API）：
 * - `hasTheaterSyntax` 分流：旧路径 / 缺机 / 多机 / 手工 AST 缺标志；
 * - `theaterUnitsStatus`：语法期丢弃、lowering 期丢弃、unit 完整但装配受限；
 * - unit 保留事实：受限单剧场、多剧场、临时桥不支持的安全目标；
 * - 状态隔离：同表隐藏槽、条件链/正文不串场、sourceMap 逐 unit、loopDepth 不继承；
 * - `@织` 文件级装配一次且不进 theater.scenes。
 */
import { describe, expect, it } from 'vitest';
import {
  compileKojoFile,
  compileKojoSource,
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  parseSource,
  type GameAdapter,
  type KojoEmitBackend,
  type KojoFile,
  type KojoLoopJumpStmt,
  type KojoNarrativeNode,
  type KojoRepeatLoop,
  type SingleTheaterBridgeRequest,
} from '../src/index.js';

const sourceOf = (lines: readonly string[]): string => lines.join('\n');

const codesOf = (result: { diagnostics: readonly { code: string }[] }): string[] =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

function withBridge(base: KojoEmitBackend, allowedTarget: string): KojoEmitBackend {
  return {
    ...base,
    temporarySingleTheaterBridge(request: SingleTheaterBridgeRequest) {
      if (request.theater.target.raw !== allowedTarget) {
        return { kind: 'unsupported', reason: `target「${request.theater.target.raw}」不在 M1 临时桥 allowlist` };
      }
      return {
        kind: 'supported',
        machine: {
          kind: 'machine',
          event: '开场',
          args: [],
          span: request.theater.headerSpan,
        },
      };
    },
  };
}

function withProgramFeatures(
  base: KojoEmitBackend,
  features: Partial<NonNullable<KojoEmitBackend['profile']['programFeatures']>>,
): KojoEmitBackend {
  const programFeatures = base.profile.programFeatures ?? {
    arrays: false,
    while: false,
    goto: false,
    recursion: false,
    foreach: false,
    repeat: false,
  };
  return {
    ...base,
    profile: {
      ...base.profile,
      programFeatures: { ...programFeatures, ...features },
    },
  };
}

function adapterWithProgramFeatures(
  base: GameAdapter,
  features: Partial<GameAdapter['programFeatures']>,
): GameAdapter {
  return { ...base, programFeatures: { ...base.programFeatures, ...features } };
}

function recordingWeaveBackend(base: KojoEmitBackend): {
  readonly backend: KojoEmitBackend;
  readonly calls: { headers: number; footers: number };
} {
  const calls = { headers: 0, footers: 0 };
  const backend: KojoEmitBackend = {
    ...base,
    weave: {
      weaveHeader(request) {
        calls.headers++;
        return base.weave.weaveHeader(request);
      },
      weaveFooter() {
        calls.footers++;
        return base.weave.weaveFooter();
      },
    },
  };
  return { backend, calls };
}

function sourceLineNumber(source: string, needle: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(needle));
  expect(index, `source 中找不到 ${needle}`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

function replaceTheaterItems(
  file: KojoFile,
  theaterIndex: number,
  items: readonly KojoNarrativeNode[],
): KojoFile {
  const theaters = (file.theaters ?? []).map((theater, index) => {
    if (index !== theaterIndex) return theater;
    const scene = theater.scenes[0] ?? {
      kind: 'sceneNode' as const,
      title: null,
      items: [],
      span: theater.headerSpan,
    };
    return { ...theater, scenes: [{ ...scene, items }] };
  });
  return { ...file, theaters };
}

describe('M1 路由：hasTheaterSyntax 是唯一分流开关', () => {
  it('旧文件带 # 机 正常编译，且不产生 theaterUnits', () => {
    const source = sourceOf(['# 机 开场', '# 视角 灵梦', '> 旧路径正文']);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.file.hasTheaterSyntax).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.theaterUnits).toBeUndefined();
    expect(result.theaterUnitsStatus).toBeUndefined();
    expect(result.erb).toContain('MACHINE 开场');
    expect(result.erb).toContain('TELL: 旧路径正文');
  });

  it('旧文件正文没有 # 机 仍报 core/decl/missing-machine，且不产生 theaterUnits', () => {
    const result = compileKojoSource({
      source: '> 没有挂点的正文',
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('core/decl/missing-machine');
    expect(result.theaterUnits).toBeUndefined();
    expect(result.theaterUnitsStatus).toBeUndefined();
  });

  it('旧文件写两条 # 机 仍报 core/decl/multiple-machine，且不产生 theaterUnits', () => {
    const source = sourceOf(['# 机 开场', '# 机 收场', '> 两个挂点']);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('core/decl/multiple-machine');
    expect(result.theaterUnits).toBeUndefined();
    expect(result.theaterUnitsStatus).toBeUndefined();
  });

  it('手工 KojoFile 缺 hasTheaterSyntax 时按旧路径处理', () => {
    const parsed = parseSource(sourceOf(['# 机 开场', '> 手工 AST']));
    const manual: KojoFile = {
      decls: parsed.decls,
      scenes: parsed.scenes,
      diagnostics: parsed.diagnostics,
    };

    const result = compileKojoFile(manual, {
      sourceText: sourceOf(['# 机 开场', '> 手工 AST']),
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect('hasTheaterSyntax' in manual).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.theaterUnits).toBeUndefined();
    expect(result.theaterUnitsStatus).toBeUndefined();
    expect(result.erb).toContain('MACHINE 开场');
  });
});

describe('M1 theaterUnitsStatus：语法期丢弃', () => {
  it.each([
    ['半角冒号头', '【剧场:初见】\n> 正文'],
    ['中间空字段', '【剧场：初见｜｜夜】\n> 正文'],
  ])('%s → discarded-syntax 且 units 为空', (_name, source) => {
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('core/theater/syntax');
    expect(result.theaterUnits).toEqual([]);
    expect(result.theaterUnitsStatus).toBe('discarded-syntax');
    expect(result.erb).toBe('');
  });

  it.each([
    ['body-before-header', '> 头前正文\n【剧场：初见】\n> 正体'],
    ['not-top-level', '@算\n    【剧场：初见】\n        x = 1'],
  ])('%s → discarded-syntax 且 units 为空', (_name, source) => {
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(false);
    expect(result.theaterUnits).toEqual([]);
    expect(result.theaterUnitsStatus).toBe('discarded-syntax');
    expect(result.erb).toBe('');
  });
});

describe('M1 theaterUnitsStatus：lowering 期丢弃', () => {
  it('@断 在循环外（lowering 注入的 AST）→ discarded-lowering 且 units 为空', () => {
    const parsed = parseSource('【剧场：初见】\n> 占位');
    const theater = parsed.theaters![0]!;
    const breakOutside: KojoLoopJumpStmt = {
      kind: 'loopJump',
      mode: 'break',
      span: theater.headerSpan,
    };
    const manual = replaceTheaterItems({ ...parsed, diagnostics: [] }, 0, [breakOutside]);

    const result = compileKojoFile(manual, {
      sourceText: '【剧场：初见】\n@断',
      adapter: FIXTURE_ADAPTER,
      backend: withBridge(FIXTURE_BACKEND, '初见'),
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('core/control/break-outside');
    expect(result.theaterUnits).toEqual([]);
    expect(result.theaterUnitsStatus).toBe('discarded-lowering');
    expect(result.erb).toBe('');
  });
});

describe('M1 unit 完整但装配受限：ok:false 仍保留 units', () => {
  it('受限单剧场：units 长度 1、status complete、erb 为空', () => {
    const source = sourceOf(['【剧场：初见｜神社｜夜】', '> 受限正文']);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: withBridge(FIXTURE_BACKEND, '初见'),
    });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.theaterUnits).toHaveLength(1);
    expect(result.theaterUnitsStatus).toBe('complete');
    expect(result.theaterUnits![0]!.theater.target.raw).toBe('初见');
    expect(codesOf(result)).toContain('core/feature/unsupported');
  });

  it('多剧场：N 个 unit 全保留、status complete、erb 为空', () => {
    const source = sourceOf([
      '【剧场：初见】',
      '> 甲正文',
      '【剧场：再见】',
      '> 乙正文',
      '【剧场：第三幕】',
      '> 丙正文',
    ]);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.theaterUnits).toHaveLength(3);
    expect(result.theaterUnitsStatus).toBe('complete');
    expect(result.theaterUnits!.map((unit) => unit.theater.target.raw)).toEqual(['初见', '再见', '第三幕']);
    expect(codesOf(result)).toContain('core/feature/unsupported');
  });

  it('临时桥不安全的 target：unit 保留、status complete、ok:false', () => {
    const source = sourceOf(['【剧场：危险目标】', '> 不安全正文']);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: withBridge(FIXTURE_BACKEND, '初见'),
    });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.theaterUnits).toHaveLength(1);
    expect(result.theaterUnitsStatus).toBe('complete');
    expect(result.theaterUnits![0]!.theater.target.raw).toBe('危险目标');
    expect(codesOf(result)).toContain('core/feature/unsupported');
  });

  it('临时桥允许的安全单剧场：unit 保留且能装配出 ERB', () => {
    const source = sourceOf(['【剧场：初见】', '> 安全正文']);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: withBridge(FIXTURE_BACKEND, '初见'),
    });

    expect(result.ok).toBe(true);
    expect(result.theaterUnits).toHaveLength(1);
    expect(result.theaterUnitsStatus).toBe('complete');
    expect(result.erb).toContain('MACHINE 开场');
    expect(result.erb).toContain('TELL: 安全正文');
  });
});

describe('M1 状态隔离：slots / 条件链 / sourceMap', () => {
  it('两个剧场共用同一张表：各自 unit.slots 独立、条件与正文不串场、sourceMap 逐 unit 对齐', () => {
    const lines = [
      '# 对照表 心情 依据 数值',
      '    0..99 -> 1',
      '    100.. -> 2',
      '    否 -> 0',
      '【剧场：甲】',
      '? 心情 == 1',
      '    > 甲一',
      '> 甲二',
      '【剧场：乙】',
      '? 心情 == 2',
      '    > 乙一',
      '> 乙二',
    ];
    const source = sourceOf(lines);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });

    expect(result.ok).toBe(false);
    expect(result.theaterUnitsStatus).toBe('complete');
    expect(result.theaterUnits).toHaveLength(2);
    const [first, second] = result.theaterUnits!;

    // 同表隐藏槽：两个 unit 都各自记录，且不是共享数组。
    expect(first!.slots.map((slot) => slot.name)).toEqual([
      '__kojo_table_心情',
      '__kojo_table_心情__value',
    ]);
    expect(second!.slots.map((slot) => slot.name)).toEqual([
      '__kojo_table_心情',
      '__kojo_table_心情__value',
    ]);
    expect(first!.slots).not.toBe(second!.slots);

    // 条件链与正文各归各的 theater。
    expect(first!.body.some((line) => line.includes('== 1'))).toBe(true);
    expect(second!.body.some((line) => line.includes('== 2'))).toBe(true);
    expect(second!.body.every((line) => !line.includes('== 1'))).toBe(true);
    expect(first!.body.some((line) => line.includes('甲一'))).toBe(true);
    expect(first!.body.some((line) => line.includes('甲二'))).toBe(true);
    expect(first!.body.every((line) => !line.includes('乙一') && !line.includes('乙二'))).toBe(true);
    expect(second!.body.some((line) => line.includes('乙一'))).toBe(true);
    expect(second!.body.some((line) => line.includes('乙二'))).toBe(true);
    expect(second!.body.every((line) => !line.includes('甲一') && !line.includes('甲二'))).toBe(true);

    // sourceMap 行数和 body 严格一致；正文行映射回本 theater 的源行。
    for (const unit of result.theaterUnits!) {
      expect(unit.sourceMap.lineCount).toBe(unit.body.length);
    }
    const firstTextIndex = first!.body.findIndex((line) => line.includes('甲一'));
    const secondTextIndex = second!.body.findIndex((line) => line.includes('乙二'));
    expect(firstTextIndex).toBeGreaterThanOrEqual(0);
    expect(secondTextIndex).toBeGreaterThanOrEqual(0);
    expect(first!.sourceMap.lineAt(firstTextIndex + 1)?.source?.start.line).toBe(
      sourceLineNumber(source, '> 甲一'),
    );
    expect(second!.sourceMap.lineAt(secondTextIndex + 1)?.source?.start.line).toBe(
      sourceLineNumber(source, '> 乙二'),
    );

    // 不允许任一 unit 的映射落进另一个 theater 的源区间。
    const firstSpan = first!.theater.span;
    const secondSpan = second!.theater.span;
    for (let line = 1; line <= first!.sourceMap.lineCount; line++) {
      const mapped = first!.sourceMap.lineAt(line)?.source;
      if (mapped === null || mapped === undefined) continue;
      const sourceLine = mapped.start.line;
      if (sourceLine >= secondSpan.start.line && sourceLine <= secondSpan.end.line) {
        throw new Error(`theater 甲 的产物行 ${line} 映射到了 theater 乙 的源行 ${sourceLine}`);
      }
      if (sourceLine >= firstSpan.start.line) {
        expect(sourceLine).toBeLessThanOrEqual(firstSpan.end.line);
      }
    }
    for (let line = 1; line <= second!.sourceMap.lineCount; line++) {
      const mapped = second!.sourceMap.lineAt(line)?.source;
      if (mapped === null || mapped === undefined) continue;
      const sourceLine = mapped.start.line;
      if (sourceLine >= firstSpan.start.line && sourceLine <= firstSpan.end.line) {
        throw new Error(`theater 乙 的产物行 ${line} 映射到了 theater 甲 的源行 ${sourceLine}`);
      }
      if (sourceLine >= secondSpan.start.line) {
        expect(sourceLine).toBeLessThanOrEqual(secondSpan.end.line);
      }
    }
  });

  it('前一个剧场的 loopDepth 不继承到后一个剧场：第二个剧场循环外 @断 仍报错', () => {
    const parsed = parseSource('【剧场：甲】\n> 甲\n【剧场：乙】\n> 乙');
    const firstTheater = parsed.theaters![0]!;
    const secondTheater = parsed.theaters![1]!;
    const inLoopBreak: KojoLoopJumpStmt = {
      kind: 'loopJump',
      mode: 'break',
      span: firstTheater.headerSpan,
    };
    const repeat: KojoRepeatLoop = {
      kind: 'repeatLoop',
      count: { text: '2', span: firstTheater.headerSpan },
      body: [inLoopBreak],
      span: firstTheater.span,
    };
    const outOfLoopBreak: KojoLoopJumpStmt = {
      kind: 'loopJump',
      mode: 'break',
      span: secondTheater.headerSpan,
    };
    let manual = replaceTheaterItems({ ...parsed, diagnostics: [] }, 0, [repeat]);
    manual = replaceTheaterItems(manual, 1, [outOfLoopBreak]);

    const result = compileKojoFile(manual, {
      sourceText: '【剧场：甲】\n@复 2\n    @断\n【剧场：乙】\n@断',
      adapter: adapterWithProgramFeatures(FIXTURE_ADAPTER, { repeat: true }),
      backend: withProgramFeatures(FIXTURE_BACKEND, { repeat: true }),
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('core/control/break-outside');
    expect(result.theaterUnits).toEqual([]);
    expect(result.theaterUnitsStatus).toBe('discarded-lowering');
  });
});

describe('M1 @织：文件级装配一次且不进 theater.scenes', () => {
  it('@织 夹在剧场正文之间：两个剧场正文都完整，监听只装配一次', () => {
    const source = sourceOf([
      '【剧场：甲】',
      '> 甲一',
      '@织 开场',
      '    > 监听体',
      '> 甲二',
      '【剧场：乙】',
      '> 乙一',
    ]);
    const recorder = recordingWeaveBackend(FIXTURE_BACKEND);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: recorder.backend,
    });

    expect(result.ok).toBe(false); // 多剧场 M1 不装配 ERB，但 unit 与 @织 仍各自完整。
    expect(result.theaterUnitsStatus).toBe('complete');
    expect(result.theaterUnits).toHaveLength(2);

    // @织 是顶层声明，不进入任何 theater.scenes。
    expect(result.file.decls.filter((decl) => decl.kind === 'weave')).toHaveLength(1);
    expect(result.file.theaters![0]!.scenes[0]!.items).toHaveLength(2);
    expect(result.file.theaters![1]!.scenes[0]!.items).toHaveLength(1);
    for (const unit of result.theaterUnits!) {
      expect(unit.body.every((line) => !line.includes('监听体'))).toBe(true);
    }

    // 第一剧场保留头尾两段；第二剧场只有自己的段落。
    const firstBody = result.theaterUnits![0]!.body.join('\n');
    const secondBody = result.theaterUnits![1]!.body.join('\n');
    expect(firstBody).toContain('TELL: 甲一');
    expect(firstBody).toContain('TELL: 甲二');
    expect(secondBody).toContain('TELL: 乙一');
    expect(secondBody).not.toContain('甲一');
    expect(secondBody).not.toContain('甲二');

    // 监听装配恰好一次（head/footer 各一次），没有按剧场重复。
    expect(recorder.calls).toEqual({ headers: 1, footers: 1 });
  });
});

describe('M1 @织 失败：丢弃全部 Theater units', () => {
  it('两个 Theater + 未知 @织 事件 → discarded-lowering、units 为空、零 ERB', () => {
    const source = sourceOf([
      '【剧场：甲】',
      '> 甲正文',
      '【剧场：乙】',
      '> 乙正文',
      '@织 不存在的事件',
      '    > 监听体',
    ]);
    const result = compileKojoSource({
      source,
      adapter: FIXTURE_ADAPTER,
      backend: withBridge(FIXTURE_BACKEND, '甲'),
    });

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.theaterUnitsStatus).toBe('discarded-lowering');
    expect(result.theaterUnits).toEqual([]);
    expect(codesOf(result)).toContain('event/unknown');
  });
});
