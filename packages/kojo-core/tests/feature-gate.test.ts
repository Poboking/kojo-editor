/**
 * K2-FEATURE-GATE-UNIFY · 能力闸单源的钉子（设计稿 §16.4 P5.8 / §16.3 A3.7）。
 *
 * 断言面（全是契约事实，不是实现细节）：
 * - **四象限**（both / adapter-only / backend-only / none）× **六键**
 *   （while / repeat / foreach / goto / arrays / recursion）：`features` 是唯一闸值，`source` 可断言；
 * - **双源不一致 = error**：两个方向各报一条，码取既有细分映射，文案点明两侧来源与修法；
 * - **同一情形只报一条**：冲突由编译入口报一次、use-site 不再重复；`(code, span)` 相同的
 *   重复命中（模板/池多次展开同一源行）只留一条；
 * - **查询面与主链同一入口**：`checkProgramFeature` 与主链同一个判定函数、同一份码；
 * - **fail-closed**：有分歧 ⇒ 零字节（口径翻转：adapter 关 / backend 开 不再"产物照出"）。
 */
import { describe, expect, it } from 'vitest';

import type {
  GameAdapter,
  KojoEmitBackend,
  KojoLoweringProfile,
  KojoSpan,
  ProgramFeatureKey,
  ProgramFeatures,
} from '../src/index.js';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  PROGRAM_FEATURE_CODES,
  PROGRAM_FEATURE_KEYS,
  checkFeature,
  checkProgramFeature,
  compileKojoSource,
  createDiagnosticSink,
  createEmitBuffer,
  createLowerState,
  featureDiagnosticKey,
  reportFeature,
  resolveProgramFeatures,
} from '../src/index.js';

/* ============================== 夹具 ============================== */

const ALL_ON: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
});

const ALL_OFF: ProgramFeatures = Object.freeze({
  arrays: false,
  while: false,
  goto: false,
  recursion: false,
  foreach: false,
  repeat: false,
});

/** 混合开关：证明逐键解析（不是整块照抄一侧） */
const MIXED: ProgramFeatures = Object.freeze({
  arrays: false,
  while: true,
  goto: true,
  recursion: true,
  foreach: false,
  repeat: false,
});

/** 声明面（adapter）：只用 `Pick` 的两项，不凑整份契约 */
function declaring(programFeatures: ProgramFeatures) {
  return { id: 'gate-adapter', programFeatures } as const;
}

/** 落点面（backend profile）：`undefined` = 该项能力没有落点声明（记录整体缺省） */
function landingProfile(programFeatures: ProgramFeatures | undefined): KojoLoweringProfile {
  return { ...FIXTURE_BACKEND.profile, programFeatures };
}

function landing(programFeatures: ProgramFeatures | undefined) {
  return { id: 'gate-backend', profile: landingProfile(programFeatures) } as const;
}

function expectFeatures(
  features: Readonly<Record<ProgramFeatureKey, boolean>>,
  expected: ProgramFeatures,
): void {
  for (const key of PROGRAM_FEATURE_KEYS) expect([key, features[key]]).toEqual([key, expected[key]]);
}

function compileWith(source: string, declared: ProgramFeatures, landed: ProgramFeatures | undefined) {
  const adapter: GameAdapter = { ...FIXTURE_ADAPTER, programFeatures: declared };
  const backend: KojoEmitBackend = { ...FIXTURE_BACKEND, profile: landingProfile(landed) };
  return compileKojoSource({ source, adapter, backend });
}

const errorsOf = (result: ReturnType<typeof compileWith>) =>
  result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

const codesOf = (result: ReturnType<typeof compileWith>) => errorsOf(result).map((diagnostic) => diagnostic.code);

function spanAt(line: number, startColumn = 1, endColumn = 8): KojoSpan {
  return { start: { line, column: startColumn }, end: { line, column: endColumn } };
}

/* ============================== 1. 四象限 × 六键 ============================== */

describe('能力闸单源 · 四象限 × 六键（features 是唯一闸值）', () => {
  it('both：两侧一致全开 ⇒ 六键 true、source = both、零诊断', () => {
    const resolved = resolveProgramFeatures(declaring(ALL_ON), landing(ALL_ON));

    expect(resolved.source).toBe('both');
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.conflicts).toEqual([]);
    expectFeatures(resolved.features, ALL_ON);
    for (const key of PROGRAM_FEATURE_KEYS) {
      expect(checkFeature(resolved, key)).toEqual({ enabled: true, diagnostic: null });
    }
  });

  it('both：两侧一致全关 ⇒ 六键 false、零冲突诊断，每个键按既有细分码报', () => {
    const resolved = resolveProgramFeatures(declaring(ALL_OFF), landing(ALL_OFF));

    expect(resolved.source).toBe('both');
    expect(resolved.diagnostics).toEqual([]);
    expectFeatures(resolved.features, ALL_OFF);
    for (const key of PROGRAM_FEATURE_KEYS) {
      const check = checkFeature(resolved, key);
      expect(check.enabled).toBe(false);
      expect(check.diagnostic?.code).toBe(PROGRAM_FEATURE_CODES[key]);
    }
  });

  it('adapter-only（查询面没有 backend）⇒ 按声明面判、source = adapter-only、零诊断', () => {
    const resolved = resolveProgramFeatures(declaring(MIXED), null);

    expect(resolved.source).toBe('adapter-only');
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.backendId).toBeNull();
    expect(resolved.adapterId).toBe('gate-adapter');
    expectFeatures(resolved.features, MIXED);
    for (const key of PROGRAM_FEATURE_KEYS) {
      expect(checkFeature(resolved, key).enabled).toBe(MIXED[key]);
    }
  });

  it('backend-only（通用 lower 没有 adapter）⇒ 按落点判、source = backend-only、零诊断', () => {
    const resolved = resolveProgramFeatures(null, landing(MIXED));

    expect(resolved.source).toBe('backend-only');
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.adapterId).toBeNull();
    expect(resolved.backendId).toBe('gate-backend');
    expectFeatures(resolved.features, MIXED);
    for (const key of PROGRAM_FEATURE_KEYS) {
      expect(checkFeature(resolved, key).enabled).toBe(MIXED[key]);
    }
  });

  it('none（两侧都没有 programFeatures 记录）⇒ 全关、source = none、零诊断（既有语义）', () => {
    const resolved = resolveProgramFeatures(null, landing(undefined));

    expect(resolved.source).toBe('none');
    expect(resolved.diagnostics).toEqual([]);
    expectFeatures(resolved.features, ALL_OFF);
    for (const key of PROGRAM_FEATURE_KEYS) {
      expect(checkFeature(resolved, key)).toMatchObject({
        enabled: false,
        diagnostic: { code: PROGRAM_FEATURE_CODES[key] },
      });
    }
  });

  it('主链 backend 没有 programFeatures 记录 ⇒ source = adapter-only，但落点未开 = 冲突（fail-closed）', () => {
    const resolved = resolveProgramFeatures(declaring(MIXED), landing(undefined));

    expect(resolved.source).toBe('adapter-only');
    // 声明为 true 的三键：落点静默 ⇒ 冲突 + 零字节；关着的三键没有冲突
    expect(resolved.conflicts).toEqual(['while', 'goto', 'recursion']);
    expect(resolved.diagnostics).toHaveLength(3);
    expectFeatures(resolved.features, ALL_OFF);
  });
});

/* ============================== 2. 双源不一致 ============================== */

describe('能力闸单源 · 双源不一致 = error（码与批-3 一致）', () => {
  it('adapter 开、backend 关 ⇒ 六键全报，文案写明"adapter 声明支持但后端落点未开启"', () => {
    const resolved = resolveProgramFeatures(declaring(ALL_ON), landing(ALL_OFF));

    expect(resolved.conflicts).toEqual([...PROGRAM_FEATURE_KEYS]);
    expect(resolved.diagnostics).toHaveLength(PROGRAM_FEATURE_KEYS.length);
    expectFeatures(resolved.features, ALL_OFF);
    for (const [index, diagnostic] of resolved.diagnostics.entries()) {
      const key = PROGRAM_FEATURE_KEYS[index]!;
      expect(diagnostic.code).toBe(PROGRAM_FEATURE_CODES[key]);
      expect(diagnostic.severity).toBe('error');
      // 文案含来源：方向 + 两侧 id + 两侧字段名 + 修法
      expect(diagnostic.message).toContain('adapter 声明支持但后端落点未开启');
      expect(diagnostic.message).toContain('gate-adapter');
      expect(diagnostic.message).toContain('gate-backend');
      expect(diagnostic.message).toContain(`adapter（gate-adapter）.programFeatures.${key}`);
      expect(diagnostic.message).toContain(`profile.programFeatures.${key}`);
      expect(diagnostic.message).toContain('@原生');
      // 声明面事实：没有具体源行
      expect(diagnostic.span).toBeNull();
    }
  });

  it('adapter 关、backend 开 ⇒ 六键全报，文案写明"后端能落但 adapter 未声明"（口径翻转的反向）', () => {
    const resolved = resolveProgramFeatures(declaring(ALL_OFF), landing(ALL_ON));

    expect(resolved.conflicts).toEqual([...PROGRAM_FEATURE_KEYS]);
    expect(resolved.diagnostics).toHaveLength(PROGRAM_FEATURE_KEYS.length);
    expectFeatures(resolved.features, ALL_OFF);
    for (const diagnostic of resolved.diagnostics) {
      expect(diagnostic.message).toContain('后端能落但 adapter 未声明');
      expect(diagnostic.message).toContain('gate-adapter');
      expect(diagnostic.message).toContain('gate-backend');
    }
  });

  it('只不一致一档：冲突只列该键，其它键按一致值走', () => {
    const resolved = resolveProgramFeatures(
      declaring({ ...ALL_ON, while: false }),
      landing({ ...ALL_ON, goto: false }),
    );

    expect(resolved.conflicts).toEqual(['while', 'goto']);
    expect(resolved.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      PROGRAM_FEATURE_CODES.while,
      PROGRAM_FEATURE_CODES.goto,
    ]);
    // 一致的三键仍为 true；冲突键折为 false
    expectFeatures(resolved.features, { ...ALL_ON, while: false, goto: false });
  });

  it('冲突键的 use-site 不再重复喊"未开启"（同一情形只一条：交给 resolve 的诊断）', () => {
    const resolved = resolveProgramFeatures(declaring(ALL_ON), landing(ALL_OFF));

    for (const key of PROGRAM_FEATURE_KEYS) {
      expect(checkFeature(resolved, key)).toEqual({ enabled: false, diagnostic: null });
    }
  });
});

/* ============================== 3. 去重 ============================== */

describe('能力闸单源 · 同一情形只报一条（去重靠 code + span）', () => {
  it('reportFeature：同一 (code, span) 重复命中只落一条，换 span 是新情形', () => {
    const sink = createDiagnosticSink();
    const state = createLowerState({ backend: FIXTURE_BACKEND, buffer: createEmitBuffer(8), sink });
    const resolved = resolveProgramFeatures(FIXTURE_ADAPTER, FIXTURE_BACKEND); // 两侧全关 ⇒ 无冲突
    const first = checkFeature(resolved, 'while', spanAt(3));
    const same = checkFeature(resolved, 'while', spanAt(3));

    reportFeature(state, first);
    reportFeature(state, same);
    expect(sink.all).toHaveLength(1);

    reportFeature(state, checkFeature(resolved, 'while', spanAt(4)));
    expect(sink.all).toHaveLength(2);
    expect(sink.all[0]!.message).toBe(sink.all[1]!.message);
  });

  it('已开启（diagnostic = null）⇒ reportFeature 什么都不报', () => {
    const sink = createDiagnosticSink();
    const state = createLowerState({ backend: FIXTURE_BACKEND, buffer: createEmitBuffer(8), sink });
    const resolved = resolveProgramFeatures(FIXTURE_ADAPTER, FIXTURE_BACKEND);

    reportFeature(state, checkFeature(resolved, 'while', spanAt(3)));
    expect(sink.all).toHaveLength(1); // 全关 ⇒ 一条
    reportFeature(state, { enabled: true, diagnostic: null });
    expect(sink.all).toHaveLength(1);
  });

  it('featureDiagnosticKey：code + 起止行列；无 span 用 `-`（稳定性口径）', () => {
    const withSpan = checkFeature(resolveProgramFeatures(FIXTURE_ADAPTER, null), 'goto', spanAt(7, 3, 9)).diagnostic!;
    expect(featureDiagnosticKey(withSpan)).toBe('core/goto/unsupported@7:3-7:9');
    const noSpan = checkFeature(resolveProgramFeatures(FIXTURE_ADAPTER, null), 'goto').diagnostic!;
    expect(featureDiagnosticKey(noSpan)).toBe('core/goto/unsupported@-');
  });

  it('主链：四个构造同时命中冲突 ⇒ 只有六条声明面 error，use-site 一条都不补', () => {
    const source = [
      '# 机 开场',
      '@标 甲',
      '@跳 甲',
      '@循 i < 3',
      '    > 一行',
      '@复 3',
      '    > 二行',
      '@巡 队伍',
      '    > 三行',
      '',
    ].join('\n');
    const result = compileWith(source, ALL_ON, ALL_OFF);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    // 六键冲突各一条（span = null 的声明面事实）；`@循`/`@复`/`@巡`/`@跳` 的 use-site 不再重复报
    expect(errorsOf(result)).toHaveLength(PROGRAM_FEATURE_KEYS.length);
    expect(errorsOf(result).every((diagnostic) => diagnostic.span === null)).toBe(true);
    expect(errorsOf(result).map((diagnostic) => diagnostic.code)).toEqual(
      PROGRAM_FEATURE_KEYS.map((key) => PROGRAM_FEATURE_CODES[key]),
    );
  });
});

/* ============================== 4. 主链接线 ============================== */

describe('能力闸单源 · 主链接线（关闭 ⇒ 恰一条 error + 零字节）', () => {
  it('`@循` 两侧都关 ⇒ core/control/unsupported，一条、零字节、span 落在节点', () => {
    const source = ['# 机 开场', '@循 i < 3', '    > 一行', ''].join('\n');
    const result = compileWith(source, ALL_OFF, ALL_OFF);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(codesOf(result)).toEqual(['core/control/unsupported']);
    expect(errorsOf(result)).toHaveLength(1);
    // span 落回源行（可点回编辑器），不是 span=null 的声明面条目
    expect(errorsOf(result)[0]!.span?.start).toEqual({ line: 2, column: 1 });
  });

  it('`@复` 两侧都关 ⇒ 与 checkProgramFeature 同码，一条、零字节', () => {
    const source = ['# 机 开场', '@复 3', '    > 一行', ''].join('\n');
    const result = compileWith(source, ALL_OFF, ALL_OFF);

    expect(codesOf(result)).toEqual(['core/control/unsupported']);
    expect(errorsOf(result)).toHaveLength(1);
    expect(result.erb).toBe('');
  });

  it('`@巡` 两侧都关 ⇒ 与 checkProgramFeature 同码、一条、零字节（能力闸优先于集合解析）', () => {
    const source = ['# 机 开场', '@巡 队伍', '    > 一行', ''].join('\n');
    const result = compileWith(source, ALL_OFF, ALL_OFF);

    expect(codesOf(result)).toEqual(['core/control/unsupported']);
    expect(errorsOf(result)).toHaveLength(1);
    expect(result.erb).toBe('');
  });

  it('`@跳` 两侧都关 ⇒ core/goto/unsupported（既有码），一条、零字节', () => {
    const source = ['# 机 开场', '@标 甲', '@跳 甲', ''].join('\n');
    const result = compileWith(source, ALL_OFF, ALL_OFF);

    expect(codesOf(result)).toEqual(['core/goto/unsupported']);
    expect(errorsOf(result)).toHaveLength(1);
    expect(result.erb).toBe('');
  });
});

/* ============================== 5. 口径翻转（主链产物面） ============================== */

describe('能力闸单源 · 口径翻转（双源不一致不再"产物面/诊断面分叉"）', () => {
  it('adapter 开、backend 关：以前产物照出（主链读 backend 只报一条），现在编译入口一条冲突 + 零字节', () => {
    const source = ['# 机 开场', '@循 i < 3', '    > 一行', ''].join('\n');
    const result = compileWith(source, ALL_ON, ALL_OFF);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    // 六键都冲突 ⇒ 六条声明面 error，且**没有**use-site 的重复条目
    expect(errorsOf(result)).toHaveLength(PROGRAM_FEATURE_KEYS.length);
    expect(errorsOf(result).every((diagnostic) => diagnostic.span === null)).toBe(true);
    expect(errorsOf(result).every((diagnostic) => diagnostic.message.includes('adapter 声明支持但后端落点未开启'))).toBe(true);
  });

  it('adapter 关、backend 开：以前主链照发字节（分叉的根源），现在冲突报错 + 零字节', () => {
    const source = ['# 机 开场', '@循 i < 3', '    > 一行', ''].join('\n');
    const result = compileWith(source, { ...ALL_ON, while: false }, ALL_ON);

    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.sourceMap.lineCount).toBe(0);
    expect(codesOf(result)).toEqual(['core/control/unsupported']);
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]!.message).toContain('后端能落但 adapter 未声明');
  });

  it('两侧一致时不产生任何能力闸诊断（不误报）', () => {
    const source = ['# 机 开场', '@循 i < 3', '    > 一行', ''].join('\n');
    const result = compileWith(source, ALL_ON, ALL_ON);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.erb.split('\n')[0]).toContain('MACHINE 开场');
  });
});

/* ============================== 6. 查询面 ============================== */

describe('能力闸单源 · 查询面（checkProgramFeature）委托同一入口', () => {
  it('六键：查询面与主链同一个判定函数、同一份码（与既有细分映射逐键一致）', () => {
    for (const key of PROGRAM_FEATURE_KEYS) {
      const viaQuery = checkProgramFeature(FIXTURE_ADAPTER, key);
      const viaMain = checkFeature(resolveProgramFeatures(FIXTURE_ADAPTER, FIXTURE_BACKEND), key).diagnostic;

      expect(viaQuery?.code).toBe(PROGRAM_FEATURE_CODES[key]);
      expect(viaMain?.code).toBe(PROGRAM_FEATURE_CODES[key]);
      expect(viaQuery?.code).toBe(viaMain?.code);
      // 文案都点明来源与逃生舱（查询面只有声明面可比，所以点名 adapter）
      expect(viaQuery?.message).toContain(FIXTURE_ADAPTER.id);
      expect(viaQuery?.message).toContain('@原生');
    }
  });

  it('开启后返回 null；span 透传给诊断', () => {
    const enabled: GameAdapter = { ...FIXTURE_ADAPTER, programFeatures: ALL_ON };
    expect(checkProgramFeature(enabled, 'while')).toBeNull();

    const span = spanAt(5, 2, 6);
    const diagnostic = checkProgramFeature(FIXTURE_ADAPTER, 'arrays', span);
    expect(diagnostic?.span).toEqual(span);
    expect(diagnostic?.code).toBe('core/array/unsupported');
  });

  it('查询面看不到 backend（已知缺口）：adapter 开就放行——落点冲突只在主链暴露', () => {
    const declared: GameAdapter = { ...FIXTURE_ADAPTER, programFeatures: ALL_ON };
    // 查询面没有 backend 参数 ⇒ 只按声明面判；主链（两侧都在）会把落点未开报成冲突。
    expect(checkProgramFeature(declared, 'while')).toBeNull();
    expect(resolveProgramFeatures(declared, landing(ALL_OFF)).conflicts).toEqual([...PROGRAM_FEATURE_KEYS]);
  });
});
