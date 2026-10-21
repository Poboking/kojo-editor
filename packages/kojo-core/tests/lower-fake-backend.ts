/**
 * 降糖测试用的假 backend（**测试替身，不是 adapter 实现**）。
 *
 * 产物行是"可断言的确定性编码"，不是 ERB：每行形如 `T|narration|-|-|wait|profile|-|-|正文`，
 * 测试直接按 `|` 切开断言 core 的决策（speech / wait / color / hint / 顺序 / 配对），
 * 而不把 adapter 的 ERB 形状拖进 core 测试。
 */
import type { KojoDiagnostic } from '../src/diagnostics.js';
import type {
  AssignEmitRequest,
  BlankEmitRequest,
  CallEmitRequest,
  EmitResult,
  ExprCallEmitRequest,
  FaceEmitRequest,
  HintSupport,
  KojoControlEmitter,
  KojoEmitBackend,
  KojoLoweringProfile,
  KojoPresentationEmitter,
  KojoProgramEmitter,
  KojoTextEmitter,
  KojoWeaveEmitter,
  OptionsEmitRequest,
  RandomEmitRequest,
  TextEmitRequest,
  WeaveEmitRequest,
} from '../src/lower/index.js';

export interface FakeBackendOptions {
  readonly profile?: Partial<KojoLoweringProfile>;
  readonly hints?: Readonly<Record<string, HintSupport>>;
  readonly sifSupported?: boolean;
  /** 命中就 fail-closed（返回诊断、不产行）；用于测 fail-closed 通道 */
  readonly failOn?: (surface: string) => readonly KojoDiagnostic[] | null;
}

export const ALL_PRESENTATIONS = {
  heart: true,
  color: true,
  face: true,
  random: true,
  options: true,
} as const;

export const ALL_PROGRAM_FEATURES = {
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
} as const;

export function fakeProfile(overrides?: Partial<KojoLoweringProfile>): KojoLoweringProfile {
  return {
    waitDefault: 'wait',
    narrationColor: 'default',
    dialogueColor: 'default',
    colorMode: 'D',
    poolStyle: 'if',
    randStyle: 'printdata',
    priorityModel: 'emuera-buckets',
    presentations: ALL_PRESENTATIONS,
    programFeatures: ALL_PROGRAM_FEATURES,
    ...overrides,
  };
}

export function textOfParts(request: TextEmitRequest): string {
  let out = '';
  for (const part of request.parts) {
    if (part.kind === 'text') {
      out += part.text;
      continue;
    }
    if (part.cond !== undefined) {
      out += `{${part.cond.cond.text}?${part.cond.then.text}:${part.cond.else.text}}`;
    } else {
      out += `{${part.expr.text}}`;
    }
  }
  return out;
}

function colorOf(request: TextEmitRequest): string {
  return request.color.kind === 'block' ? `block:${request.color.color.text}` : 'profile';
}

export function createFakeBackend(options?: FakeBackendOptions): KojoEmitBackend & {
  readonly calls: string[];
} {
  const profile = fakeProfile(options?.profile);
  const hints: Readonly<Record<string, HintSupport>> = options?.hints ?? {
    心形: profile.presentations.heart ? 'supported' : 'unsupported',
    微笑: 'annotation',
  };
  const calls: string[] = [];

  const fail = (surface: string): EmitResult => {
    const diagnostics = options?.failOn?.(surface);
    return diagnostics === null || diagnostics === undefined ? null : { diagnostics };
  };

  const text: KojoTextEmitter = {
    line(request: TextEmitRequest): EmitResult {
      calls.push(`text:${request.speech.kind}`);
      const failed = fail('text');
      if (failed !== null) return failed;
      const body = textOfParts(request);
      if (request.hintRole === 'supported' && request.hint !== null) {
        return `HPH|${request.wait}|${request.hint}|${body}`;
      }
      return [
        'T',
        request.speech.kind,
        request.speaker ?? '',
        request.defaultSpeaker ?? '',
        request.wait,
        colorOf(request),
        request.hint ?? '',
        request.hintRole ?? '',
        body,
      ].join('|');
    },
  };

  const blank: KojoEmitBackend['blank'] = {
    line(request: BlankEmitRequest): EmitResult {
      calls.push('blank');
      return fail('blank') ?? `B|${request.wait}`;
    },
  };

  const control: KojoControlEmitter = {
    sifSupported: options?.sifSupported ?? true,
    ifHeader: (test) => `IF|${test.text}`,
    elseIfHeader: (test) => `ELSEIF|${test.text}`,
    elseHeader: () => 'ELSE',
    ifFooter: () => 'ENDIF',
    sifHeader: (test) => `SIF|${test.text}`,
  };

  const presentation: KojoPresentationEmitter = {
    colorEnter: (color) => `COLOR|enter|${color.text}`,
    colorExit: () => 'COLOR|exit',
    face(request: FaceEmitRequest): EmitResult {
      return fail('face') ?? `FACE|${request.object ?? ''}|${request.args.map((a) => a.text).join(',')}`;
    },
    randomBlock(request: RandomEmitRequest, lowerCandidate): EmitResult {
      const failed = fail('random');
      if (failed !== null) return failed;
      const lines: string[] = [`RAND|${request.purity}|${request.slot}`];
      request.candidates.forEach((candidate, index) => {
        for (const line of lowerCandidate(candidate, index)) lines.push(line);
      });
      lines.push('RANDEND');
      return lines;
    },
    optionsBlock(request: OptionsEmitRequest, lowerItem): EmitResult {
      const failed = fail('options');
      if (failed !== null) return failed;
      const lines: string[] = [`OPTIONS|${request.items.map((item) => item.label).join('|')}`];
      request.items.forEach((item, index) => {
        for (const line of lowerItem(item, index)) lines.push(line);
      });
      lines.push('OPTIONSEND');
      return lines;
    },
  };

  const weave: KojoWeaveEmitter = {
    weaveHeader(request: WeaveEmitRequest): EmitResult {
      const failed = fail('weave');
      if (failed !== null) return failed;
      return `WEAVE|${request.event}|${request.modifiers.join(',')}`;
    },
    weaveFooter: () => 'WEAVEEND',
  };

  const program: KojoProgramEmitter = {
    sandboxEnter: () => 'SANDBOX',
    sandboxExit: () => 'SANDBOXEND',
    assign(request: AssignEmitRequest) {
      return `ASSIGN|${request.target.text}|${request.op}|${request.value.text}`;
    },
    call(request: CallEmitRequest) {
      return `CALL|${request.name}(${request.args.map((a) => a.text).join(',')})`;
    },
    exprCall(request: ExprCallEmitRequest) {
      return `EXPRCALL|${request.call.text}`;
    },
    loopJump: (mode) => (mode === 'break' ? 'BREAK' : 'CONTINUE'),
    returnValue: (value) => `RETURN|${value?.text ?? ''}`,
    label: (name) => `LABEL|${name}`,
    jump: (target) => `JUMP|${target}`,
    whileHeader: (test) => `WHILE|${test.text}`,
    whileFooter: () => 'WHILEEND',
    repeatHeader: (count) => `REPEAT|${count.text}`,
    repeatFooter: () => 'REPEATEND',
    forEachHeader: (collection) => `FOREACH|${collection.text}`,
    forEachFooter: () => 'FOREACHEND',
  };

  return {
    id: 'fake',
    profile,
    hintSupport: (hint) => hints[hint] ?? 'annotation',
    text,
    blank,
    control,
    presentation,
    weave,
    program,
    calls,
  };
}
