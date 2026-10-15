/**
 * §3.2 时机块头 `参数:`（v1.5）——**带实参的调用面**必须声明形参。
 *
 * 立据（沙盒引擎实测，见规范 §9）：未声明形参的函数被带实参调用时，
 * **实参被引擎静默丢弃**（`CALL INNER(7,8)` 而 `@INNER` 不声明 → `INNER` 内 `ARG` 读到 0）。
 * 分发器对事件/特殊事件系是
 * `TRYCALLFORM M_KOJO%RESULTS%_EVENT_K{NO}_%ARGS:1%(ARGS:2,ARG:3,ARG:4)`，
 * 故这些调用面的糖函数头**必须**带 `(ARG,ARG:1)`——否则产物跑得动、读到的全是 0。
 *
 * 三处发射点（缺一处即为不忠实转译）：包装头 / 包装体内转发的 `CALL` / `_1` 头。
 * 另含**关闭态**断言：不写 `参数:` 时产物逐字节不变。
 */

import { describe, expect, it } from 'vitest';
import type { TimingBlock } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '../src/service';
import { isStructuralLine } from '../src/preview';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { TIMING_ARG_TOKENS, TIMING_NAMED_PARAMS } from '../src/index';
import { segmentParamName } from '../src/codegen';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);
const codes = (src: string) => t(src).diagnostics.map((d) => d.code);
const errMsgs = (src: string) =>
  t(src)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);

/** 头一行 → 产物里的声明串（`参数:` 的三个发射点共用同一份） */
const head = (erb: string, name: string) => erb.split('\n').find((l) => l.startsWith(`@${name}`)) ?? null;

/* ============================================================================ */
/* 正写：三个发射点                                                              */
/* ============================================================================ */

describe('§3.2 参数: · 三个发射点（规范 §3.2 v1.5 / §5.5）', () => {
  const BARE = '角色: 12\n时机 事件 1：\n    「嗯。」\n';
  const DECL = '角色: 12\n时机 事件 1 参数: ARG,ARG:1：\n    「嗯。」\n';

  /** 无声明时的**冻结产物**（逐字节锁死"不写 = 一切照旧"） */
  const BARE_ERB = [
    '@M_KOJO_EVENT_K12_1',
    'CALL M_KOJO_EVENT_K12_1_1',
    'RETURN RESULT',
    '',
    '@M_KOJO_EVENT_K12_1_1',
    ';-------------------------------------------------',
    ';記入チェック（=0, 非表示、1, 表示）',
    'LOCAL = 1',
    ';-------------------------------------------------',
    'IF LOCAL',
    '\tPRINTFORMW 「嗯。」',
    'ENDIF',
    'RETURN 1',
    '',
  ].join('\n');

  it('不写 `参数:` → 产物逐字节等于冻结基准（无回归）', () => {
    const r = t(BARE);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toBe(BARE_ERB);
  });

  it('写 `参数:` → 诊断为空，且包装头 / 转发 CALL / `_1` 头**三处同带**声明', () => {
    const r = t(DECL);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toContain('@M_KOJO_EVENT_K12_1(ARG,ARG:1)');
    expect(r.erb).toContain('CALL M_KOJO_EVENT_K12_1_1(ARG,ARG:1)');
    expect(r.erb).toContain('@M_KOJO_EVENT_K12_1_1(ARG,ARG:1)');
  });

  it('转发**逐字**：三处的声明串完全一致（不多不少不换写法）', () => {
    const { erb } = t(DECL);
    const lines = erb.split('\n');
    const wrapHead = lines.find((l) => l.startsWith('@M_KOJO_EVENT_K12_1('));
    const call = lines.find((l) => l.startsWith('CALL M_KOJO_EVENT_K12_1_1'));
    const bodyHead = lines.find((l) => l.startsWith('@M_KOJO_EVENT_K12_1_1'));
    const clause = '(ARG,ARG:1)';
    expect(wrapHead).toBe(`@M_KOJO_EVENT_K12_1${clause}`);
    expect(call).toBe(`CALL M_KOJO_EVENT_K12_1_1${clause}`);
    expect(bodyHead).toBe(`@M_KOJO_EVENT_K12_1_1${clause}`);
  });

  it('与无声明版**只差那三行**（正文 / 骨架 / 骨架行数一律不动）', () => {
    const bare = t(BARE).erb.split('\n');
    const decl = t(DECL).erb.split('\n');
    const withClause = (l: string): string =>
      l === '@M_KOJO_EVENT_K12_1'
        ? '@M_KOJO_EVENT_K12_1(ARG,ARG:1)'
        : l === '@M_KOJO_EVENT_K12_1_1'
          ? '@M_KOJO_EVENT_K12_1_1(ARG,ARG:1)'
          : l === 'CALL M_KOJO_EVENT_K12_1_1'
            ? 'CALL M_KOJO_EVENT_K12_1_1(ARG,ARG:1)'
            : l;
    expect(decl).toEqual(bare.map(withClause));
  });

  it('行级源映射**不受声明段影响**（同位置同行号；源映射不是事后 diff 反推的）', () => {
    expect(t(DECL).sourceMap).toEqual(t(BARE).sourceMap);
  });

  it('单令牌声明 `参数: ARG` 同样成立（不假定必须两支）', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 事件 1 参数: ARG：\n    「嗯。」\n');
    expect(diagnostics).toEqual([]);
    expect(head(erb, 'M_KOJO_EVENT_K12_1')).toBe('@M_KOJO_EVENT_K12_1(ARG)');
    expect(erb).toContain('CALL M_KOJO_EVENT_K12_1_1(ARG)');
  });

  it('编号外的分野同样可用（`特殊事件` / 无编号的 `初见`）', () => {
    const spe = t('角色: 12\n时机 特殊事件 2 参数: ARG,ARG:1：\n    「嗯。」\n').erb;
    expect(head(spe, 'M_KOJO_SPEVENT_K12_2')).toBe('@M_KOJO_SPEVENT_K12_2(ARG,ARG:1)');
    const enc = t('角色: 12\n时机 初见 参数: ARG：\n    「嗯。」\n').erb;
    expect(head(enc, 'M_KOJO_ENCOUNTER_K12')).toBe('@M_KOJO_ENCOUNTER_K12(ARG)');
  });

  it('`参数:` 与 `类型:` / `成否:` 同头共存，互不干扰', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n时机 指令 310 类型: SCOM 成否: 一定成功 参数: ARG,ARG:1：\n    「嗯。」\n',
    );
    expect(diagnostics).toEqual([]);
    // `类型: SCOM` 仍切到副指令段
    expect(head(erb, 'M_KOJO_MESSAGE_SCOM_K12_310')).toBe('@M_KOJO_MESSAGE_SCOM_K12_310(ARG,ARG:1)');
    // `成否:` 仍生成 SUCCESS 函数
    expect(erb).toContain('@M_KOJO_SUCCESS_SCOM_K12_310');
    expect(erb).toContain('TFLAG:192 = 1');
  });

  it('英文别名 `args:` 与中文主形同解（规范 §4.1 中英双收，只影响输入）', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 事件 1 args: ARG,ARG:1：\n    「嗯。」\n');
    expect(diagnostics).toEqual([]);
    expect(head(erb, 'M_KOJO_EVENT_K12_1')).toBe('@M_KOJO_EVENT_K12_1(ARG,ARG:1)');
  });

  it('声明串的三种合法排版归一为同一份产物（逗号后空白 / 全角逗号 / 无空白）', () => {
    const variants = [
      '时机 事件 1 参数: ARG,ARG:1：',
      '时机 事件 1 参数: ARG, ARG:1：',
      '时机 事件 1 参数: ARG，ARG:1：',
    ];
    const products = variants.map((h) => t(`角色: 12\n${h}\n    「嗯。」\n`));
    for (const p of products) expect(p.diagnostics).toEqual([]);
    expect(products[1]!.erb).toBe(products[0]!.erb);
    expect(products[2]!.erb).toBe(products[0]!.erb);
  });

  it('保守口径：伴生函数（SUCCESS / MESSAGECHECK）**不带**声明——只作用于本时机的主体两函数', () => {
    const { erb, diagnostics } = t(
      '角色: 12\n时机 指令 311 成否: 一定成功 参数: ARG,ARG:1：\n    隐藏情景: 如果 TFLAG:193 == 1\n    「嗯。」\n',
    );
    expect(diagnostics).toEqual([]);
    expect(erb).toContain('@M_KOJO_MESSAGE_COM_K12_311(ARG,ARG:1)');
    expect(erb).toContain('CALL M_KOJO_MESSAGE_COM_K12_311_1(ARG,ARG:1)');
    // SUCCESS 与 MESSAGECHECK 保持裸头（分发器对它们是另一套调用协议）
    expect(head(erb, 'M_KOJO_SUCCESS_COM_K12_311')).toBe('@M_KOJO_SUCCESS_COM_K12_311');
    expect(head(erb, 'M_KOJO_MESSAGE_MESSAGECHECK_COM_K12_311')).toBe('@M_KOJO_MESSAGE_MESSAGECHECK_COM_K12_311');
  });
});

/* ============================================================================ */
/* 校验：只认 `ARG` / `ARG:<数字>`                                               */
/* ============================================================================ */

describe('§3.2 参数: · 取值校验（非法即 error，不出半个非法函数头）', () => {
  const withParam = (v: string) => `角色: 12\n时机 事件 1 参数: ${v}：\n    「嗯。」\n`;

  it('合法：`ARG` / `ARG:1` / `ARG:10` / **裸 `ARGS`** 及其逗号组合', () => {
    // 裸 `ARGS` = 整组实参记号：引擎 `TRYCALLFORM …_K{No}_%ARGS:1%(ARGS:2,ARG:3,ARG:4)`
    // 形态的调用面（图像口上）语料侧正是 `(ARGS,ARG,ARG:1)`（见 `图像` 面用例）。
    for (const v of [
      'ARG',
      'ARG:1',
      'ARG:10',
      'ARG,ARG:1',
      'ARG,ARG:1,ARG:2',
      'ARG:0',
      'ARGS',
      'ARGS,ARG,ARG:1',
    ]) {
      expect(errMsgs(withParam(v)), v).toEqual([]);
    }
  });

  it('非法：`FOO` → 一条 error，消息点名 `参数:` 并给出合法写法', () => {
    const r = t(withParam('FOO'));
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe('timing-face-unknown'); // 复用既有码（契约闭集，不发明字符串）
    expect(errs[0]!.message).toContain('参数:');
    expect(errs[0]!.message).toContain('FOO');
    expect(errs[0]!.loc?.line).toBe(2); // 指回块头那一行
  });

  it('非法：`ARGS:2` / `ARG:x` / 空令牌 / 非令牌中文词 一律拒绝', () => {
    for (const v of ['ARGS:2', 'ARG:x', 'ARG,', 'ARG,,ARG:1', '她', 'LOCAL', 'ARG1', 'ARG:1,FOO']) {
      expect(errMsgs(withParam(v)), `"${v}"`).not.toEqual([]);
    }
  });

  it('空值声明 `参数:`（冒号同时是块头终止符）→ parse 层 error，不静默退化为"没写"', () => {
    const r = t(withParam(''));
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe('timing-face-unknown');
    expect(errs[0]!.message).toContain('参数:');
    // 且非法声明不进产物
    expect(r.erb).toContain('@M_KOJO_EVENT_K12_1\n');
  });

  it('非法声明不进产物（按"未声明"出裸头，错误由诊断拦住保存）', () => {
    const r = t(withParam('FOO'));
    expect(r.erb).toContain('@M_KOJO_EVENT_K12_1\n');
    expect(r.erb).not.toContain('FOO');
    expect(r.erb).not.toContain('(@');
  });

  it('合法但重复声明 `参数:` → 取第一条（与 `成否:` / `类型:` 同一 `.find` 口径）', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 事件 1 参数: ARG 参数: ARG,ARG:1：\n    「嗯。」\n');
    expect(diagnostics).toEqual([]);
    expect(head(erb, 'M_KOJO_EVENT_K12_1')).toBe('@M_KOJO_EVENT_K12_1(ARG)');
  });
});

/* ============================================================================ */
/* 中文主形令牌（v1.7）：`实参` / `实参$` + **全局 1 基**索引                      */
/* ============================================================================ */

describe('§3.2 参数: · 中文主形令牌（v1.7 表层）', () => {
  const withParam = (v: string) => `角色: 12\n时机 事件 1 参数: ${v}：\n    「嗯。」\n`;

  it('中文主形归一为引擎记号：`实参`/`实参:2`/`实参$`/`实参$:2` → `ARG`/`ARG:1`/`ARGS`/`ARGS:1`（全局 1 基）', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['实参', 'ARG'],
      ['实参:2', 'ARG:1'],
      ['实参:3', 'ARG:2'],
      ['实参$', 'ARGS'],
      ['实参$:2', 'ARGS:1'],
      ['实参,实参$:2', 'ARG,ARGS:1'],
    ];
    for (const [cn, engine] of cases) {
      const { erb, diagnostics } = t(withParam(cn));
      expect(diagnostics, cn).toEqual([]);
      expect(head(erb, 'M_KOJO_EVENT_K12_1'), cn).toBe(`@M_KOJO_EVENT_K12_1(${engine})`);
    }
  });

  it('中文主形与等价旧写法**产物逐字节一致**（归一为同一引擎记号闭集）', () => {
    expect(t(withParam('实参,实参:2')).erb).toBe(t(withParam('ARG,ARG:1')).erb);
    expect(t(withParam('实参$')).erb).toBe(t(withParam('ARGS')).erb);
  });

  it('非法中文索引一律拒绝：`实参:0` / `实参$:0` / `实参:x` / `实参$:x`', () => {
    for (const v of ['实参:0', '实参$:0', '实参:x', '实参$:x']) {
      expect(errMsgs(withParam(v)), `"${v}"`).not.toEqual([]);
    }
  });

  it('时机体内按声明槽位降糖：`参数: 实参,实参$:2` 的正文里 `{实参:2}` → `{ARG:1}`', () => {
    const { erb, diagnostics } = t('角色: 12\n时机 事件 1 参数: 实参,实参$:2：\n    「第{实参:2}位」\n');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(erb).toContain('{ARG:1}');
  });

  it('时机体内引用未声明位置（声明 2 槽位却写 `实参:3`）→ `unknown-identifier` error', () => {
    const { diagnostics } = t('角色: 12\n时机 事件 1 参数: 实参,实参$:2：\n    「位置3 = {实参:3}」\n');
    expect(diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toContain('unknown-identifier');
  });
});

/* ============================================================================ */
/* AST / 源映射 / 撞名 / 投影                                                    */
/* ============================================================================ */

describe('§3.2 参数: · AST 承载与下游', () => {
  const timingOf = (src: string): TimingBlock => {
    const doc = svc().parse(src);
    const node = doc.topLevel.find((n) => n.kind === 'timingBlock');
    expect(node).toBeDefined();
    return node as TimingBlock;
  };

  it('声明存在时机节点的 `namedParams` 上，名归一为中文规范形', () => {
    const timing = timingOf('角色: 12\n时机 事件 1 args: ARG,ARG:1：\n    「嗯。」\n');
    expect(timing.namedParams).toHaveLength(1);
    expect(timing.namedParams[0]!.name).toBe('参数');
    expect(timing.namedParams[0]!.value).toBe('ARG,ARG:1');
  });

  it('命名参数的源区间回填到块头行（词法层的 zeroSpan 不外泄）', () => {
    const timing = timingOf('角色: 12\n时机 事件 1 参数: ARG,ARG:1：\n    「嗯。」\n');
    expect(timing.namedParams[0]!.loc.start.line).toBe(2);
    expect(timing.loc.start.line).toBe(2);
  });

  it('带声明的时机之间**仍做撞名检测**（声明段不算进函数名）', () => {
    const src =
      '角色: 12\n时机 事件 1 参数: ARG,ARG:1：\n    「甲。」\n时机 事件 1 参数: ARG,ARG:1：\n    「乙。」\n';
    expect(codes(src)).toContain('function-name-duplicate');
  });

  it('声明版与裸写版撞同一函数名 → 照样报（跨写法口径一致）', () => {
    const src = '角色: 12\n时机 事件 1 参数: ARG,ARG:1：\n    「甲。」\n时机 事件 1：\n    「乙。」\n';
    expect(codes(src)).toContain('function-name-duplicate');
  });

  it('预览骨架判定：转发 `CALL X_1(ARG,ARG:1)` 仍是骨架；带文本实参的 `CALL` 不是', () => {
    expect(isStructuralLine('CALL M_KOJO_EVENT_K12_1_1(ARG,ARG:1)')).toBe(true);
    expect(isStructuralLine('CALL M_KOJO_EVENT_K12_1_1(ARG)')).toBe(true);
    expect(isStructuralLine('CALL M_KOJO_EVENT_K12_1_1')).toBe(true);
    expect(isStructuralLine('CALL HPH_PRINT(@"嗯。","w")')).toBe(false);
    expect(isStructuralLine('CALL SOME_FN(LOCAL)')).toBe(false);
  });

  it('糖投影：带声明的包装三联照旧被吸收（读者只看到一条「时机 事件 1：」）', () => {
    const deps: LiftDeps = {
      transpile: () => {
        throw new Error('投影不应调用 transpile');
      },
      scanControlFlow: (text: string) => scanControlFlow(text),
      faceTable: () => stubFaceTable(),
    };
    const wrapper = (call: string, bodyHead: string): string =>
      [
        '@M_KOJO_EVENT_K12_1(ARG,ARG:1)',
        call,
        'RETURN RESULT',
        bodyHead,
        'PRINTFORMW 甲',
      ].join('\n');

    // 三处声明一致 → 与裸写版同一待遇：`_1` 头被吸收，不多出一条"时机"
    const ok = liftProject(deps, { source: wrapper('CALL M_KOJO_EVENT_K12_1_1(ARG,ARG:1)', '@M_KOJO_EVENT_K12_1_1(ARG,ARG:1)') });
    expect(ok.segments[0]!.sugarText.split('\n')).toEqual(['时机 事件 1：', '\t甲']);
    expect(ok.segments[0]!.toLine).toBe(5);

    // `CALL` 少转发声明 = 真实功能差异（实参会被引擎丢弃），**不**许当排版噪声吸收。
    // 不吸收的证据 = 转发行本身仍在读者视野里。**不是**靠 `_1` 尾巴区分两个头：
    // E13-1 起 `{i}` 的委托后缀 `_1` 一律剥除，桩与正文的标签同形——那正是糖
    // `时机 事件 1：` 一次生成这两个函数的现实。
    const bad = liftProject(deps, { source: wrapper('CALL M_KOJO_EVENT_K12_1_1', '@M_KOJO_EVENT_K12_1_1(ARG,ARG:1)') });
    // 桩没被合并 ⇒ 两个函数头各自成段（合并版只有 1 段，见上面的 `ok`）
    expect(bad.segments).toHaveLength(2);
    const badText = bad.segments.map((s) => s.sugarText).join('\n');
    expect(badText.match(/时机 事件 1：/g)).toHaveLength(2);
  });
});

/* ============================================================================ */
/* KC-2b：时机命名参数**键表**（单一真源；宿主补全据本表派生键 / 取值候选）        */
/* ============================================================================ */

describe('KC-2b · 时机命名参数键表（单一真源导出）', () => {
  it('键表含已验证集合 成否 / 类型 / 参数，各带取值来源', () => {
    expect(TIMING_NAMED_PARAMS.map((p) => p.name)).toEqual(['成否', '类型', '参数']);
    const byName = new Map(TIMING_NAMED_PARAMS.map((p) => [p.name, p]));
    expect(byName.get('成否')!.valueSource).toBe('successFlag');
    expect(byName.get('类型')!.valueSource).toBe('segment');
    expect(byName.get('类型')!.segmentName).toBe('com');
    expect(byName.get('参数')!.valueSource).toBe('args');
    expect(byName.get('参数')!.alias).toBe('args');
  });

  it('`类型` 的段名映射与转译器 `segmentParamName` 同源（com → 类型）', () => {
    expect(segmentParamName('com')).toBe('类型');
    expect(segmentParamName('未知段')).toBeUndefined();
  });

  it('`参数:` 取值候选为语言层闭集（裸 ARG / 带索引 ARG:<数字> / 裸 ARGS）', () => {
    // v1.7：补全据 `argTokenCnLabel` 派生中文主形展示（`实参` / `实参:2` / `实参$`），
    // 本闭集仍是**引擎记号**真源（编辑器侧零硬编码）。
    expect(TIMING_ARG_TOKENS).toEqual(['ARG', 'ARG:1', 'ARGS']);
  });
});
