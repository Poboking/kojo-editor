/**
 * lowering 骨架单测：文本三正交 / 空行三态 / `?` 链 first-match+SIF / `@原生` 逐行 /
 * `@着色` 配对与转移清理 / `@颜绘` / `@随机` 纯度 / `@织` 能力闸 / `@算`+program 形状 /
 * `选项` 待定 warning / fail-closed 通道 / source map 逐行映射 / 缓冲区契约。
 */
import { describe, expect, it } from 'vitest';
import type {
  KojoAssignStmt,
  KojoBlankLine,
  KojoCallStmt,
  KojoColorBlock,
  KojoConditionBranch,
  KojoConditionChain,
  KojoDecl,
  KojoDispatchNode,
  KojoExprCallStmt,
  KojoExprText,
  KojoFaceLine,
  KojoFile,
  KojoForEachLoop,
  KojoJumpStmt,
  KojoLabelStmt,
  KojoLoopJumpStmt,
  KojoNarrativeNode,
  KojoNativeBlock,
  KojoOptionItem,
  KojoOptionsBlock,
  KojoRandomCandidate,
  KojoRandomBlock,
  KojoRepeatLoop,
  KojoSandboxBlock,
  KojoSceneNode,
  KojoSpan,
  KojoTextLine,
  KojoWaitMode,
  KojoWeaveDecl,
  KojoWhileLoop,
} from '../src/ast.js';
import { createDiagnosticSink } from '../src/diagnostics.js';
import type { LowerResult } from '../src/lower/index.js';
import { lowerFile, lowerNarrative } from '../src/lower/index.js';
import { createEmitBuffer } from '../src/lower/index.js';
import { createFakeBackend } from './lower-fake-backend.js';

const span = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 8 },
});

const expr = (text: string, line = 1): KojoExprText => ({
  text,
  span: { start: { line, column: 1 }, end: { line, column: 1 + text.length } },
});

const narration = (text: string, line = 1, wait: KojoWaitMode = 'default'): KojoTextLine => ({
  kind: 'textLine',
  speech: { kind: 'narration' },
  parts: [{ kind: 'text', text }],
  wait,
  span: span(line),
});

const dialogue = (speaker: string, text: string, line = 1, wait: KojoWaitMode = 'default', hint?: string): KojoTextLine => ({
  kind: 'textLine',
  speech: { kind: 'dialogue', speaker },
  parts: [{ kind: 'text', text }],
  wait,
  span: span(line),
  ...(hint === undefined ? {} : { hint }),
});

const bareQuote = (text: string, line = 1): KojoTextLine => ({
  kind: 'textLine',
  speech: { kind: 'bareQuote' },
  parts: [{ kind: 'text', text }],
  wait: 'default',
  span: span(line),
});

const blank = (wait: KojoWaitMode = 'default', line = 1): KojoBlankLine => ({ kind: 'blankLine', wait, span: span(line) });

const branch = (test: string | null, body: readonly KojoNarrativeNode[], line = 1): KojoConditionBranch => ({
  test: test === null ? null : expr(test, line),
  body,
  span: span(line),
});

const chain = (branches: readonly KojoConditionBranch[], line = 1): KojoConditionChain => ({ kind: 'conditionChain', branches, span: span(line) });

const colorBlock = (color: string, body: KojoColorBlock['body'], line = 1): KojoColorBlock => ({
  kind: 'colorBlock',
  color: expr(color, line),
  body,
  span: span(line),
});

const nativeBlock = (lines: readonly string[], line = 10): KojoNativeBlock => ({ kind: 'nativeBlock', lines, span: span(line) });

const faceLine = (object: 'me' | 'you' | null, args: readonly string[], line = 1): KojoFaceLine => ({
  kind: 'faceLine',
  object,
  args: args.map((a) => expr(a, line)),
  span: span(line),
});

const sandbox = (body: readonly KojoDispatchNode[], line = 1): KojoSandboxBlock => ({ kind: 'sandboxBlock', body, span: span(line) });

const assign = (target: string, value: string, line = 1, op: KojoAssignStmt['op'] = '='): KojoAssignStmt => ({
  kind: 'assign',
  target: { text: target, span: span(line) },
  op,
  value: expr(value, line),
  span: span(line),
});

const call = (name: string, args: readonly string[], line = 1): KojoCallStmt => ({
  kind: 'call',
  name,
  args: args.map((a) => expr(a, line)),
  span: span(line),
});

const exprCall = (text: string, line = 1): KojoExprCallStmt => ({ kind: 'exprCall', call: expr(text, line), span: span(line) });
const loopJump = (mode: 'break' | 'continue', line = 1): KojoLoopJumpStmt => ({ kind: 'loopJump', mode, span: span(line) });
const whileLoop = (test: string, body: readonly KojoDispatchNode[], line = 1): KojoWhileLoop => ({
  kind: 'whileLoop',
  test: expr(test, line),
  body,
  span: span(line),
});
const repeatLoop = (count: string, body: readonly KojoDispatchNode[], line = 1): KojoRepeatLoop => ({
  kind: 'repeatLoop',
  count: expr(count, line),
  body,
  span: span(line),
});
const forEachLoop = (collection: string, body: readonly KojoNarrativeNode[], line = 1): KojoForEachLoop => ({
  kind: 'forEachLoop',
  collection: expr(collection, line),
  body,
  span: span(line),
});
const label = (name: string, line = 1): KojoLabelStmt => ({ kind: 'label', name, span: span(line) });
const jump = (target: string, line = 1): KojoJumpStmt => ({ kind: 'jump', target, span: span(line) });

const randomLineCandidate = (line: KojoTextLine | KojoBlankLine, lineNo = 1): KojoRandomCandidate => ({
  kind: 'randomLine',
  line,
  span: span(lineNo),
});
const randomGroupCandidate = (body: readonly KojoNarrativeNode[], line = 1): KojoRandomCandidate => ({
  kind: 'randomGroup',
  body,
  span: span(line),
});
const randomBlock = (candidates: readonly KojoRandomCandidate[], line = 1): KojoRandomBlock => ({
  kind: 'randomBlock',
  candidates,
  span: span(line),
});

const optionsBlock = (items: readonly { label: string; body: readonly KojoNarrativeNode[] }[], line = 1): KojoOptionsBlock => ({
  kind: 'optionsBlock',
  items: items.map((item, index): KojoOptionItem => ({ label: item.label, body: item.body, span: span(line + index) })),
  span: span(line),
});

const scene = (items: readonly KojoNarrativeNode[], title: string | null = null): KojoSceneNode => ({
  kind: 'sceneNode',
  title,
  items,
  span: span(1),
});

const file = (scenes: readonly KojoSceneNode[], decls: readonly KojoDecl[] = []): KojoFile => ({
  decls,
  scenes,
  diagnostics: [],
});

const codes = (result: LowerResult): readonly string[] => result.diagnostics.map((d) => d.code);
const run = (nodes: readonly KojoNarrativeNode[], backend = createFakeBackend()): LowerResult =>
  lowerNarrative(nodes, { backend, estimatedLines: nodes.length });

describe('文本三正交：speech × color × wait', () => {
  it('旁白：无 `续` 走 profile.waitDefault；颜色交 profile', () => {
    const result = run([narration('风声')]);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(['T|narration|||wait|profile|||风声']);
  });

  it('台词：speech=dialogue + speaker 原样交给 adapter', () => {
    const result = run([dialogue('灵梦', '早', 1, 'continue')]);
    expect(result.lines).toEqual(['T|dialogue|灵梦||continue|profile|||早']);
  });

  it('行尾 `续` 覆盖 waitDefault；`空行 等待/续` 三态各自独立', () => {
    const result = run([narration('甲', 1, 'continue'), blank('default', 2), blank('wait', 3), blank('continue', 4)]);
    expect(result.lines).toEqual([
      'T|narration|||continue|profile|||甲',
      'B|wait', // profile.waitDefault = wait
      'B|wait',
      'B|continue',
    ]);
  });

  it('缺 waitDefault → core/wait/no-profile，且该行不产字节（fail-closed）', () => {
    const backend = createFakeBackend({ profile: { waitDefault: undefined } });
    const result = run([narration('甲', 1, 'default'), narration('乙', 2, 'continue')], backend);
    expect(codes(result)).toEqual(['core/wait/no-profile']);
    expect(result.ok).toBe(false);
    expect(result.lines).toEqual(['T|narration|||continue|profile|||乙']);
  });

  it('插值片段原样交给 adapter（core 不解析表达式）', () => {
    const node: KojoTextLine = {
      ...narration('前缀', 1),
      parts: [
        { kind: 'text', text: '你好，' },
        { kind: 'interp', expr: expr('名字') },
        { kind: 'text', text: '！' },
      ],
    };
    expect(run([node]).lines).toEqual(['T|narration|||wait|profile|||你好，{名字}！']);
  });

  it('池内裸引号：默认说话人取当前 # 视', () => {
    const result = lowerFile(file([scene([bareQuote('早')])], [{ kind: 'view', target: '灵梦', span: span(1) }]), {
      backend: createFakeBackend(),
    });
    expect(result.lines).toEqual(['T|bareQuote||灵梦|wait|profile|||早']);
  });

  it('池内裸引号无 # 视 → core/pool/no-view', () => {
    const result = run([bareQuote('早')]);
    expect(codes(result)).toEqual(['core/pool/no-view']);
    expect(result.lines).toEqual([]);
  });
});

describe('行尾表演提示：adapter 判定，core 只按三态阻断', () => {
  it('已知提示（心形）→ supported，adapter 可用 HPH 变体', () => {
    const result = run([dialogue('灵梦', '嗯', 1, 'continue', '心形')]);
    expect(result.lines).toEqual(['HPH|continue|心形|嗯']);
  });

  it('未知提示 = 导演批注（annotation），不阻断', () => {
    const result = run([dialogue('灵梦', '嗯', 1, 'default', '微笑')]);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(['T|dialogue|灵梦||wait|profile|微笑|annotation|嗯']);
  });

  it('adapter 认识但没声明演出 → core/feature/unsupported，不生成有效变体', () => {
    const backend = createFakeBackend({ profile: { presentations: { heart: false, color: true, face: true, random: true, options: true } } });
    const result = run([dialogue('灵梦', '嗯', 1, 'default', '心形')], backend);
    expect(codes(result)).toEqual(['core/feature/unsupported']);
    // fail-closed：不能按 HPH 变体产行；按批注路径发普通行，编译整体 error
    expect(result.lines[0]).toContain('T|dialogue');
    expect(result.lines[0]).toContain('annotation');
  });

  it('未知提示交给 adapter 判定（fake 里 `微笑` = annotation）', () => {
    const backend = createFakeBackend({ hints: { 心形: 'supported', 微笑: 'annotation' } });
    expect(run([narration('她笑了', 1, 'default')], backend).lines[0]).toContain('T|narration');
  });
});

describe('`?` 条件链：first-match + SIF', () => {
  const threeWay = chain([
    branch('恋慕 >= 500', [narration('近', 2)], 1),
    branch('恋慕 >= 100', [narration('中', 4)], 3),
    branch(null, [narration('远', 6)], 5),
  ]);

  it('发 IF / ELSEIF / ELSE / ENDIF，顺序 = 源顺序（不排序）', () => {
    const result = run([threeWay]);
    expect(result.lines).toEqual([
      'IF|恋慕 >= 500',
      'T|narration|||wait|profile|||近',
      'ELSEIF|恋慕 >= 100',
      'T|narration|||wait|profile|||中',
      'ELSE',
      'T|narration|||wait|profile|||远',
      'ENDIF',
    ]);
  });

  it('单真分支 + 单行体 + adapter 支持 SIF → SIF + 一行（无 ENDIF）', () => {
    const result = run([chain([branch('A', [narration('甲', 2)], 1)])]);
    expect(result.lines).toEqual(['SIF|A', 'T|narration|||wait|profile|||甲']);
  });

  it('adapter 不支持 SIF → 回落完整 IF 链', () => {
    const backend = createFakeBackend({ sifSupported: false });
    expect(run([chain([branch('A', [narration('甲', 2)], 1)])], backend).lines).toEqual([
      'IF|A',
      'T|narration|||wait|profile|||甲',
      'ENDIF',
    ]);
  });

  it('分支体多行 / 带 `? 否` 不降 SIF', () => {
    const multi = chain([branch('A', [narration('甲', 2), narration('乙', 3)], 1)]);
    expect(run([multi]).lines[0]).toBe('IF|A');
    const withElse = chain([branch('A', [narration('甲', 2)], 1), branch(null, [narration('乙', 3)], 2)]);
    expect(run([withElse]).lines).toEqual([
      'IF|A',
      'T|narration|||wait|profile|||甲',
      'ELSE',
      'T|narration|||wait|profile|||乙',
      'ENDIF',
    ]);
  });

  it('调度区条件链复用同一 first-match 判据', () => {
    const node = sandbox([
      {
        kind: 'dispatchCondition',
        branches: [
          { test: expr('A'), body: [assign('x', '1', 3)], span: span(2) },
          { test: null, body: [assign('x', '2', 5)], span: span(4) },
        ],
        span: span(2),
      },
    ]);
    const result = run([node]);
    expect(result.lines).toEqual(['SANDBOX', 'IF|A', 'ASSIGN|x|=|1', 'ELSE', 'ASSIGN|x|=|2', 'ENDIF', 'SANDBOXEND']);
  });
});

describe('`@原生`：逐行透传 + 折回物理行', () => {
  it('块体原样逐行输出；source map 指向块头下一行起', () => {
    const result = run([nativeBlock(['; raw', 'CALL HPH_PRINT "w"'], 10)]);
    expect(result.lines).toEqual(['; raw', 'CALL HPH_PRINT "w"']);
    expect(result.sourceMap.lineAt(1)?.kind).toBe('native');
    expect(result.sourceMap.lineAt(1)?.source?.start.line).toBe(11);
    expect(result.sourceMap.lineAt(2)?.source?.start.line).toBe(12);
  });

  it('空块 → core/native/empty，不产字节', () => {
    const result = run([nativeBlock([])]);
    expect(codes(result)).toEqual(['core/native/empty']);
    expect(result.lines).toEqual([]);
  });

  it('`@着色` 块内写 `@原生` → core/native/disallowed-location', () => {
    const result = run([colorBlock('0xFF0000', [nativeBlock(['PRINTL x'], 5)])]);
    expect(codes(result)).toContain('core/native/disallowed-location');
    expect(result.lines).toEqual(['COLOR|enter|0xFF0000', 'COLOR|exit']);
  });
});

describe('`@着色`：自动配对 / 嵌套 error / 转移清理 / no-output warning', () => {
  it('块内文本带 block 颜色轴；进入/退出自动配对', () => {
    const result = run([colorBlock('0xFF8080', [narration('红', 2), dialogue('灵梦', '嗯', 3)], 1)]);
    expect(result.lines).toEqual([
      'COLOR|enter|0xFF8080',
      'T|narration|||wait|block:0xFF8080|||红',
      'T|dialogue|灵梦||wait|block:0xFF8080|||嗯',
      'COLOR|exit',
    ]);
  });

  it('嵌套 `@着色` → core/color/nested；体内按外层颜色继续（不产内层 SETCOLOR）', () => {
    const inner = colorBlock('0x00FF00', [narration('内', 3)], 2);
    const outer = colorBlock('0xFF0000', [narration('外', 2), inner], 1);
    const result = run([outer]);
    expect(codes(result)).toEqual(['core/color/nested']);
    expect(result.lines).toEqual([
      'COLOR|enter|0xFF0000',
      'T|narration|||wait|block:0xFF0000|||外',
      'T|narration|||wait|block:0xFF0000|||内',
      'COLOR|exit',
    ]);
  });

  it('adapter 未声明着色 → core/color/unsupported，不产 SETCOLOR/RESETCOLOR', () => {
    const backend = createFakeBackend({ profile: { presentations: { heart: true, color: false, face: true, random: true, options: true } } });
    const result = run([colorBlock('0xFF0000', [narration('红', 2)])], backend);
    expect(codes(result)).toEqual(['core/color/unsupported']);
    expect(result.lines).toEqual([]);
  });

  it('块内只有计算 → core/color/no-output（warning，不阻断）', () => {
    const result = run([colorBlock('0xFF0000', [sandbox([assign('x', '1', 3)], 2)], 1)]);
    expect(codes(result)).toContain('core/color/no-output');
    const warning = result.diagnostics.find((d) => d.code === 'core/color/no-output')!;
    expect(warning.severity).toBe('warning');
    expect(result.ok).toBe(true);
  });

  it('控制转移自动 RESETCOLOR（只补一次；块尾不重复）', () => {
    const loop = whileLoop('i < 3', [loopJump('break', 4)], 3);
    const result = run([colorBlock('0xFF0000', [sandbox([loop], 2)], 1)]);
    expect(result.lines).toEqual([
      'COLOR|enter|0xFF0000',
      'SANDBOX',
      'WHILE|i < 3',
      'COLOR|exit',
      'BREAK',
      'WHILEEND',
      'SANDBOXEND',
    ]);
  });
});

describe('`@颜绘` / `@随机` / `选项`', () => {
  it('颜绘：对象与参数原样给 adapter', () => {
    const result = run([faceLine('me', ['笑顔', '服1'], 1)]);
    expect(result.lines).toEqual(['FACE|me|笑顔,服1']);
  });

  it('颜绘：adapter 未声明 → unsupported；参数超 4 个 → args', () => {
    const noFace = createFakeBackend({ profile: { presentations: { heart: true, color: true, face: false, random: true, options: true } } });
    expect(codes(run([faceLine('me', ['笑顔'])], noFace))).toEqual(['core/face/unsupported']);
    expect(codes(run([faceLine('me', ['a', 'b', 'c', 'd', 'e'])]))).toEqual(['core/face/args']);
    expect(run([faceLine('me', ['a', 'b', 'c', 'd', 'e'])]).lines).toEqual([]);
  });

  it('随机：单行纯文本 → single-line-text；落点由 adapter 决定', () => {
    const result = run([randomBlock([randomLineCandidate(narration('甲', 2), 2), randomLineCandidate(narration('乙', 3), 3)], 1)]);
    expect(result.lines[0]).toBe('RAND|single-line-text|__kojo_rand_1');
    expect(result.lines.at(-1)).toBe('RANDEND');
    expect(result.lines).toContain('T|narration|||wait|profile|||甲');
  });

  it('随机：多行 @组 纯文本 → group-text；含插值/空行/控制流 → control-or-side-effect', () => {
    const pureGroup = randomBlock([
      randomGroupCandidate([narration('甲', 2), narration('乙', 3)], 2),
      randomLineCandidate(narration('丙', 4), 4),
    ]);
    expect(run([pureGroup]).lines[0]).toBe('RAND|group-text|__kojo_rand_1');

    const withInterp: KojoTextLine = {
      ...narration('甲', 2),
      parts: [{ kind: 'interp', expr: expr('心情') }],
    };
    const interp = randomBlock([randomLineCandidate(withInterp, 2), randomLineCandidate(narration('乙', 3), 3)]);
    expect(run([interp]).lines[0]).toBe('RAND|control-or-side-effect|__kojo_rand_1');

    const withBlank = randomBlock([
      randomGroupCandidate([narration('甲', 2), blank('default', 3)], 2),
      randomLineCandidate(narration('乙', 4), 4),
    ]);
    expect(run([withBlank]).lines[0]).toBe('RAND|control-or-side-effect|__kojo_rand_1');
  });

  it('随机：候选不足 2 个 / adapter 未声明 → error 且不产字节', () => {
    expect(codes(run([randomBlock([randomLineCandidate(narration('甲', 2), 2)], 1)]))).toEqual(['core/random/one-candidate']);
    const noRandom = createFakeBackend({ profile: { presentations: { heart: true, color: true, face: true, random: false, options: true } } });
    const result = run([randomBlock([randomLineCandidate(narration('甲', 2), 2), randomLineCandidate(narration('乙', 3), 3)], 1)], noRandom);
    expect(codes(result)).toEqual(['core/random/unsupported']);
    expect(result.lines).toEqual([]);
  });

  it('选项：永远给待定 warning；adapter 声明 UI 才落点', () => {
    const node = optionsBlock([
      { label: '甲', body: [narration('正文甲', 3)] },
      { label: '乙', body: [narration('正文乙', 4)] },
    ]);
    const result = run([node]);
    expect(codes(result)).toContain('core/options/pending');
    expect(result.diagnostics.find((d) => d.code === 'core/options/pending')?.severity).toBe('warning');
    expect(result.lines).toEqual([
      'OPTIONS|甲|乙',
      'T|narration|||wait|profile|||正文甲',
      'T|narration|||wait|profile|||正文乙',
      'OPTIONSEND',
    ]);

    const noUi = createFakeBackend({ profile: { presentations: { heart: true, color: true, face: true, random: true, options: false } } });
    const blocked = run([node], noUi);
    expect(codes(blocked)).toEqual(['core/options/pending', 'core/feature/unsupported']);
    expect(blocked.lines).toEqual([]);
  });
});

describe('`@织`：形状与能力闸', () => {
  const weave = (modifiers: KojoWeaveDecl['modifiers'], body = [narration('雨', 3)]): KojoWeaveDecl => ({
    kind: 'weave',
    event: '回合末',
    args: [],
    modifiers,
    body,
    span: span(1),
  });

  it('普通监听：WEAVE 头 + 体 + 尾', () => {
    const result = lowerFile(file([], [weave([])]), { backend: createFakeBackend() });
    expect(result.lines).toEqual(['WEAVE|回合末|', 'T|narration|||wait|profile|||雨', 'WEAVEEND']);
  });

  it('`之前/之后/接管`：adapter 声明 emuera-buckets 才可用', () => {
    const ok = lowerFile(file([], [weave(['later'])]), { backend: createFakeBackend() });
    expect(ok.lines[0]).toBe('WEAVE|回合末|later');

    const noBuckets = createFakeBackend({ profile: { priorityModel: 'none' } });
    const blocked = lowerFile(file([], [weave(['later'])]), { backend: noBuckets });
    expect(codes(blocked)).toEqual(['core/weave/unsupported']);
    expect(blocked.lines).toEqual([]);
  });

  it('修饰词重复 / `接管` 与 `之前之后` 并用 → modifier-conflict，不产字节', () => {
    const dup = lowerFile(file([], [weave(['later', 'later'])]), { backend: createFakeBackend() });
    expect(codes(dup)).toEqual(['core/weave/modifier-conflict']);
    expect(dup.lines).toEqual([]);
    const mixed = lowerFile(file([], [weave(['only', 'later'])]), { backend: createFakeBackend() });
    expect(codes(mixed)).toEqual(['core/weave/modifier-conflict']);
  });
});

describe('`@算` / program 形状与能力闸', () => {
  it('赋值 / `!` 调用 / 裸调用逐条交给 adapter', () => {
    const result = run([sandbox([assign('temp', '1', 2), call('记录', ['x'], 3), exprCall('foo()', 4)], 1)]);
    expect(result.lines).toEqual(['SANDBOX', 'ASSIGN|temp|=|1', 'CALL|记录(x)', 'EXPRCALL|foo()', 'SANDBOXEND']);
  });

  it('循环外 `@断`/`@续` → error 且不产字节', () => {
    expect(codes(run([sandbox([loopJump('break', 2), loopJump('continue', 3)], 1)]))).toEqual([
      'core/control/break-outside',
      'core/control/continue-outside',
    ]);
    const result = run([sandbox([loopJump('break', 2)], 1)]);
    expect(result.lines).toEqual(['SANDBOX', 'SANDBOXEND']);
  });

  it('`@循` 体内 `@断` → 正常；未开启 while → error', () => {
    const ok = run([sandbox([whileLoop('i < 3', [loopJump('break', 3), assign('i', 'i + 1', 4)], 2)], 1)]);
    expect(ok.lines).toEqual(['SANDBOX', 'WHILE|i < 3', 'BREAK', 'ASSIGN|i|=|i + 1', 'WHILEEND', 'SANDBOXEND']);

    const noWhile = createFakeBackend({
      profile: { programFeatures: { arrays: true, while: false, goto: true, recursion: true, foreach: true, repeat: true } },
    });
    const blocked = run([sandbox([whileLoop('i < 3', [], 2)], 1)], noWhile);
    expect(codes(blocked)).toEqual(['core/control/unsupported']);
    expect(blocked.lines).toEqual(['SANDBOX', 'SANDBOXEND']);
  });

  it('`@复` 静态非正次数 → bad-repeat；正常次数产头尾', () => {
    expect(codes(run([sandbox([repeatLoop('0', [], 2)], 1)]))).toEqual(['core/control/bad-repeat']);
    const ok = run([sandbox([repeatLoop('3', [assign('x', '1', 3)], 2)], 1)]);
    expect(ok.lines).toEqual(['SANDBOX', 'REPEAT|3', 'ASSIGN|x|=|1', 'REPEATEND', 'SANDBOXEND']);
  });

  it('`@巡`：集合交 adapter，体是叙事节点', () => {
    const result = run([sandbox([forEachLoop('队伍', [narration('第{下标}位', 3)], 2)], 1)]);
    expect(result.lines).toEqual(['SANDBOX', 'FOREACH|队伍', 'T|narration|||wait|profile|||第{下标}位', 'FOREACHEND', 'SANDBOXEND']);
  });

  it('`@标`/`@跳`：goto 未开启 → core/goto/unsupported', () => {
    const ok = run([sandbox([label('主菜单', 2), jump('主菜单', 3)], 1)]);
    expect(ok.lines).toEqual(['SANDBOX', 'LABEL|主菜单', 'JUMP|主菜单', 'SANDBOXEND']);

    const noGoto = createFakeBackend({
      profile: { programFeatures: { arrays: true, while: true, goto: false, recursion: true, foreach: true, repeat: true } },
    });
    const blocked = run([sandbox([label('甲', 2), jump('甲', 3)], 1)], noGoto);
    expect(codes(blocked)).toEqual(['core/goto/unsupported']);
    expect(blocked.lines).toEqual(['SANDBOX', 'LABEL|甲', 'SANDBOXEND']);
  });

  it('`@返` 在函数外 → core/func/return-outside', () => {
    const ret: KojoDispatchNode = { kind: 'return', value: expr('1', 2), span: span(2) };
    expect(codes(run([sandbox([ret], 1)]))).toEqual(['core/func/return-outside']);
  });

  it('叙事区 loop / call 复用调度分发器（不复制第二份判据）', () => {
    const result = run([call('早安问候', [], 1), whileLoop('A', [narration('循环台词', 3)], 2)]);
    expect(result.lines).toEqual(['CALL|早安问候()', 'WHILE|A', 'T|narration|||wait|profile|||循环台词', 'WHILEEND']);
  });
});

describe('fail-closed 通道与 source map 映射', () => {
  it('backend 返回 EmitFailure → 收诊断、该段不产字节，其余照常', () => {
    const backend = createFakeBackend({
      failOn: (surface) => (surface === 'text' ? [{ code: 'text/literal', severity: 'error', message: '字面量表达不了', span: null }] : null),
    });
    const result = run([narration('坏', 1), narration('好', 2)], backend);
    expect(result.ok).toBe(false);
    // 两行都走同一 fail-closed 通道：诊断各一条、一行字节都不产
    expect(codes(result)).toEqual(['text/literal', 'text/literal']);
    expect(result.lines).toEqual([]);
  });

  it('每行产物都回源到节点 span；一源多行（随机块）整块映射块头（§10.7 隐藏槽 → 块头）', () => {
    const node = randomBlock([randomLineCandidate(narration('甲', 3), 3), randomLineCandidate(narration('乙', 4), 4)], 2);
    const result = run([node]);
    // 随机块由 adapter 组装（PRINTDATA / RAND+SELECTCASE 形状不同），core 把整块映射到块头：
    // 隐藏槽、块头、候选正文都能点回 `@随机` 那一行，不会落到邻居行上。
    for (let line = 1; line <= result.sourceMap.lineCount; line++) {
      expect(result.sourceMap.lineAt(line)?.source).toEqual(node.span);
    }
  });

  it('文件级诊断被收进结果（不丢）；ok=false', () => {
    const withDiagnostics: KojoFile = {
      decls: [],
      scenes: [scene([])],
      diagnostics: [{ code: 'core/migration/if', severity: 'error', message: '旧写法', span: span(1) }],
    };
    const result = lowerFile(withDiagnostics, { backend: createFakeBackend() });
    expect(codes(result)).toEqual(['core/migration/if']);
    expect(result.ok).toBe(false);
  });
});

describe('EmitBuffer 契约', () => {
  it('预分配 + 追加 + finish 截断；finish 幂等', () => {
    const buffer = createEmitBuffer(4);
    buffer.push('a', { source: span(1) });
    buffer.push('b', { source: null });
    expect(buffer.lineCount).toBe(2);
    const finished = buffer.finish();
    expect(finished.lines).toEqual(['a', 'b']);
    expect(finished.lines).toHaveLength(2);
    expect(buffer.finish()).toBe(finished);
    expect(() => buffer.push('c', { source: span(2) })).toThrow(/单向数据流/);
  });

  it('pushEmitted：null 不产行；多行各自映射；EmitFailure 收诊断', () => {
    const buffer = createEmitBuffer();
    const sink = createDiagnosticSink();
    buffer.pushEmitted(null, { source: span(1) }, sink);
    buffer.pushEmitted(['x', 'y'], { source: span(2) }, sink);
    buffer.pushEmitted(
      { diagnostics: [{ code: 'text/x', severity: 'error', message: '不行', span: null }] },
      { source: span(3) },
      sink,
    );
    const finished = buffer.finish();
    expect(finished.lines).toEqual(['x', 'y']);
    expect(sink.hasError()).toBe(true);
    expect(finished.sourceMap.lineAt(1)?.source).toEqual(span(2));
    expect(finished.sourceMap.lineAt(2)?.source).toEqual(span(2));
  });
});
