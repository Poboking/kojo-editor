/**
 * 内置 fixture adapter —— core / adapter-sdk 测试的**唯一**游戏侧依赖（§16.3 A3.14）。
 *
 * 纪律：
 * - **零 IO、零游戏名词**：事件名与引擎落点都是抽象占位（OPEN / CLOSE / VIEW / PLAYER），
 *   任何真实游戏的口上事实都不许出现在这里；具体游戏的 adapter 住在各自插件包。
 * - 最小面：2 个事件、`{我}` / `{你}` 两个代词、wait/color 缺省、只有场景存储、
 *   program 全关、presentation 全 null、域符号变量四条（`domainSymbols.variables`，additive 面）——
 *   这样 core 测试既能跑通契约自检，
 *   也能稳定踩到"未知事件 / 未声明能力 / 未声明存储期"的错误路径。
 * - 数据在模块装载时深冻结一次：之后查表零构造开销。
 */
import type { GameAdapter } from './adapter.js';
import { deepFreeze, freezeAdapter } from './adapter.js';
import type { KojoExprText, KojoOptionItem, KojoRandomCandidate, KojoTextPart } from './ast.js';
import type {
  AssignEmitRequest,
  BlankEmitRequest,
  CallEmitRequest,
  EmitResult,
  ExprCallEmitRequest,
  FaceEmitRequest,
  ForEachEmitRequest,
  HintSupport,
  KojoEmitBackend,
  KojoLoweringProfile,
  MachineWrapRequest,
  OptionsEmitRequest,
  RandomEmitRequest,
  ResolvedWait,
  TextEmitRequest,
  WeaveEmitRequest,
} from './lower/backend.js';

/** fixture 的固定指纹（换盘检测逻辑的最小可用输入） */
export const FIXTURE_FINGERPRINT = Object.freeze({
  digest: 'fixture@1',
  entries: Object.freeze([Object.freeze({ kind: 'engine' as const, value: '1.0' })]),
});

/**
 * 最小 adapter：契约齐全、能力最小。
 *
 * 刻意留空的三个面（都用于错误路径测试，而不是"忘了填"）：
 * - `presentation` 四项全 null → `checkPresentation` 必须报"当前 adapter 不支持"；
 * - `programFeatures` 全 false + `features` 空 → `checkProgramFeature` 必须报未开启；
 * - `storageClasses` 只有 `场景` → `checkStoragePeriod('save' | 'session')` 必须报未声明。
 */
export const FIXTURE_ADAPTER: GameAdapter = freezeAdapter({
  id: 'fixture',
  version: '2.0.0',

  gameFingerprint: FIXTURE_FINGERPRINT,

  eventCatalog: {
    defaultEvent: '开场',
    events: [
      {
        event: '开场',
        engine: 'OPEN',
        args: [],
        dispatch: 'engine-dispatch',
        priority: 'load-order',
        guard: null,
        forced: true,
        weavable: true,
      },
      {
        event: '收场',
        engine: 'CLOSE',
        args: [{ name: '编号', kind: 'int', required: false }],
        dispatch: 'engine-dispatch',
        priority: 'load-order',
        guard: null,
        forced: false,
        weavable: true,
      },
    ],
  },

  domainSymbols: {
    pronouns: [
      {
        role: 'me',
        pronoun: '我',
        engineRef: 'VIEW',
        requiresView: true,
        viewBound: true,
        family: 'VIEW',
      },
      {
        role: 'you',
        pronoun: '你',
        engineRef: 'PLAYER',
        requiresView: false,
        viewBound: false,
        family: 'PLAYER',
      },
    ],
    attributes: [
      {
        name: '数值',
        family: 'VAR',
        index: 0,
        valueKind: 'int',
        readonly: false,
        description: 'fixture 用的通用数值属性',
      },
    ],
    nameFunctions: [{ name: '名字', engine: 'NAME_OF', args: ['对象'], returns: 'string' }],
    /**
     * 域符号变量（additive 面）：四条覆盖三种 `valueKind` + 只读，供 sema 的
     * "外部变量赋值 / 只读 / 类型兼容 / 旧 adapter 省略字段"四类判定各取正反例。
     * 名字一律 `外部…` 前缀：fixture 是伪游戏，不借真实游戏词；也不与上面的
     * 代词 / 属性 / 名字函数撞名（撞名是装载期 error）。
     */
    variables: [
      { name: '外部计数', valueKind: 'int' },
      { name: '外部文本', valueKind: 'string' },
      { name: '外部上限', valueKind: 'int', readonly: true },
      { name: '外部角色', valueKind: 'character' },
    ],
    speakers: { kind: 'closed', names: ['我', '你'] },
    unknown: 'error',
  },

  profile: {
    narrationColor: 'default',
    dialogueColor: 'default',
    waitDefault: 'wait',
    colorMode: 'plain',
    poolStyle: 'if',
    randStyle: 'rand-selectcase',
    features: [],
  },

  presentation: { heart: null, color: null, face: null, options: null },

  storageClasses: {
    classes: [
      {
        period: 'scene',
        engine: 'LOCAL',
        init: 'on-entry',
        persisted: false,
        slotPrefix: '__fixture_scene_',
        description: '进入事件即建、退出即弃的局部槽',
      },
    ],
    slotStability: 'project-stable',
  },

  programFeatures: {
    arrays: false,
    while: false,
    goto: false,
    recursion: false,
    foreach: false,
    repeat: false,
  },

  // 老 adapter 的兼容面：null = 不支持 `@巡`（fixture 用错误路径测 fail-closed）
  foreachCollections: null,

  encodingPolicy: {
    defaultEncoding: 'utf-8',
    allowedEncodings: ['utf-8', 'utf-8-bom', 'utf-16le-bom'],
    eol: 'mixed',
    preserveBom: true,
    normalizeOnSave: false,
    fingerprintMismatch: 'warn',
  },

  layerPolicy: { defaultMode: 'unique', rules: [] },

  diagnosticNamespace: {
    namespaces: ['event', 'symbol'],
    codes: ['event/unknown', 'symbol/unknown'],
  },

  capability: {
    executesCode: false,
    fileAccess: 'read-project',
    networkAccess: 'none',
    writablePaths: 'user-approved',
    integrity: 'none',
  },

  sourceMap: {
    granularity: 'line',
    mapsEventHeader: true,
    mapsTemplateExpansion: true,
    mapsPoolExpansion: true,
    mapsNativeLines: true,
    mapsRandomSlots: true,
  },

  conformanceSuite: {
    required: ['golden', 'differential', 'smoke', 'encoding'],
    cases: [
      { kind: 'golden', name: 'fixture 叙事 golden', fixture: 'fixture/golden' },
      { kind: 'differential', name: 'fixture 产出一致性', fixture: 'fixture/differential' },
      { kind: 'smoke', name: 'fixture 冒烟', fixture: 'fixture/smoke' },
      { kind: 'encoding', name: 'fixture 编码保留', fixture: 'fixture/encoding' },
    ],
  },
});

/* ============================== fixture emit backend ============================== */

/**
 * 最小的 `KojoEmitBackend` 实现（core 降糖测试用）。
 *
 * 这是**伪引擎**：产物 token（`SAY` / `BLANK` / `IF` / `COLOR.ENTER` …）只用来让
 * core 的降糖结构可断言，不代表任何真实游戏/引擎；真实 adapter 的 backend 在自己
 * 的包里把同一接口落到该游戏的打印/着色/立绘指令一类事实上。
 *
 * 契约要点（见 `lower/backend.ts` 头注）：
 * - 文本/空行/颜绘每次**至多一行**（`?` 链的 `SIF` 降级依赖它）；
 * - 表达式在这里**不编译**，原样渲染成 `{源切片}`——表达式到引擎的编译属于
 *   宿主注入的 expression 管线，不是 fixture 的职责；
 * - fixture adapter 没声明任何演出面 → 所有行尾提示都是导演批注（不打印）。
 */
const FIXTURE_PRESENTATIONS = Object.freeze({
  heart: false,
  color: false,
  face: false,
  random: true,
  options: false,
});

/** profile 读数：逐字段从 `FIXTURE_ADAPTER.profile` 派生，不另抄一份默认值 */
export const FIXTURE_LOWERING_PROFILE: KojoLoweringProfile = Object.freeze({
  waitDefault: FIXTURE_ADAPTER.profile.waitDefault,
  narrationColor: FIXTURE_ADAPTER.profile.narrationColor,
  dialogueColor: FIXTURE_ADAPTER.profile.dialogueColor,
  colorMode: FIXTURE_ADAPTER.profile.colorMode,
  poolStyle: FIXTURE_ADAPTER.profile.poolStyle,
  randStyle: FIXTURE_ADAPTER.profile.randStyle,
  // fixture 事件表全是 load-order → 之前/之后/接管 不可用
  priorityModel: 'none',
  presentations: FIXTURE_PRESENTATIONS,
  programFeatures: FIXTURE_ADAPTER.programFeatures,
});

function renderParts(parts: readonly KojoTextPart[]): string {
  let out = '';
  for (const part of parts) {
    out += part.kind === 'text' ? part.text : `{${part.expr.text}}`;
  }
  return out;
}

function renderArgs(args: readonly KojoExprText[]): string {
  return args.map((arg) => arg.text).join(', ');
}

function waitSuffix(wait: ResolvedWait): string {
  return wait === 'wait' ? '/WAIT' : '/CONT';
}

/** fixture 伪引擎 backend（冻结；纯函数、无状态） */
export const FIXTURE_BACKEND: KojoEmitBackend = freezeBackend({
  id: FIXTURE_ADAPTER.id,
  profile: FIXTURE_LOWERING_PROFILE,

  // fixture 不认识任何演出提示：全部归"导演批注"（不打印，保留在 source map）
  hintSupport(_hint: string): HintSupport {
    return 'annotation';
  },

  /**
   * `# 机` 最小事件头（确定性字节，core 的 compile/golden 按它钉）：
   * `MACHINE <event> [args…]` → 每个隐藏槽一行注释 → body 原样 → `MACHINE.END`。
   *
   * fixture 是伪引擎、没有真变量声明，故 slots 只落注释（真 adapter 落引擎等价物）；
   * body 行**逐字嵌入、顺序不变**（source map 靠核心的连续子序列匹配）。
   */
  wrapMachine(request: MachineWrapRequest): EmitResult {
    const head = ['MACHINE', request.machine.event, ...request.machine.args].join(' ');
    const slots = request.slots.map((slot) => `;SLOT ${slot.name} ${slot.kind} ${slot.valueType}`);
    return [head, ...slots, ...request.body, 'MACHINE.END'];
  },

  text: {
    /** 至多一行：`SAY <说话人>: <正文> <颜色轴> <等待轴>` */
    line(request: TextEmitRequest): EmitResult {
      const content = renderParts(request.parts);
      const speaker =
        request.speech.kind === 'narration'
          ? 'TELL'
          : request.speech.kind === 'dialogue'
            ? `SAY ${request.speech.speaker}`
            : `SAY ${request.defaultSpeaker ?? '?'}`;
      const color = request.color.kind === 'block' ? ` COLOR ${request.color.color.text}` : '';
      const hint = request.hint !== null && request.hintRole === 'annotation' ? ` ;(${request.hint})` : '';
      return `${speaker}: ${content}${color} ${waitSuffix(request.wait)}${hint}`;
    },
  },

  blank: {
    line(request: BlankEmitRequest): EmitResult {
      return `BLANK ${waitSuffix(request.wait)}`;
    },
  },

  control: {
    // fixture 引擎支持单行 SIF：core 可走 §5.2 的 SIF 优化分支
    sifSupported: true,
    ifHeader(test: KojoExprText): EmitResult {
      return `IF {${test.text}}`;
    },
    elseIfHeader(test: KojoExprText): EmitResult {
      return `ELSEIF {${test.text}}`;
    },
    elseHeader(): EmitResult {
      return 'ELSE';
    },
    ifFooter(): EmitResult {
      return 'ENDIF';
    },
    sifHeader(test: KojoExprText): EmitResult {
      return `SIF {${test.text}}`;
    },
  },

  presentation: {
    colorEnter(color: KojoExprText): EmitResult {
      return `COLOR.ENTER {${color.text}}`;
    },
    colorExit(): EmitResult {
      return 'COLOR.EXIT';
    },
    face(request: FaceEmitRequest): EmitResult {
      return `FACE ${request.object ?? 'me'} ${renderArgs(request.args)}`.trimEnd();
    },
    /**
     * `@随机`：fixture 没有真正的变体族，但按契约把"头 + 各候选已降糖行 + 尾"
     * 组装成完整产物（候选行由 core 的 `lowerCandidate` 回调返回，顺序由 backend 定）。
     */
    randomBlock(
      request: RandomEmitRequest,
      lowerCandidate: (candidate: KojoRandomCandidate, index: number) => readonly string[],
    ): EmitResult {
      const lines: string[] = [`RANDOM ${request.purity} ${request.candidates.length}`];
      request.candidates.forEach((candidate, index) => {
        lines.push(...lowerCandidate(candidate, index));
      });
      lines.push('RANDOM.END');
      return lines;
    },
    /** `选项`：同上，按钮正文由 core 的 `lowerItem` 回调返回 */
    optionsBlock(
      request: OptionsEmitRequest,
      lowerItem: (item: KojoOptionItem, index: number) => readonly string[],
    ): EmitResult {
      const lines: string[] = [`OPTIONS ${request.items.length}`];
      request.items.forEach((item, index) => {
        lines.push(...lowerItem(item, index));
      });
      lines.push('OPTIONS.END');
      return lines;
    },
  },

  weave: {
    weaveHeader(request: WeaveEmitRequest): EmitResult {
      return `WEAVE ${[request.event, ...request.args, ...request.modifiers].join(' ')}`;
    },
    weaveFooter(): EmitResult {
      return 'WEAVE.END';
    },
  },

  program: {
    sandboxEnter(): EmitResult {
      return null;
    },
    sandboxExit(): EmitResult {
      return null;
    },
    assign(request: AssignEmitRequest): EmitResult {
      return `SET ${request.target.text} ${request.op} {${request.value.text}}`;
    },
    call(request: CallEmitRequest): EmitResult {
      return `CALL ${request.name}(${renderArgs(request.args)})`;
    },
    exprCall(request: ExprCallEmitRequest): EmitResult {
      return `CALL ${request.call.text}`;
    },
    loopJump(mode: 'break' | 'continue'): EmitResult {
      return mode === 'break' ? 'BREAK' : 'CONTINUE';
    },
    returnValue(value: KojoExprText | null): EmitResult {
      return value === null ? 'RETURN' : `RETURN {${value.text}}`;
    },
    label(name: string): EmitResult {
      return `LABEL ${name}`;
    },
    jump(target: string): EmitResult {
      return `GOTO ${target}`;
    },
    whileHeader(test: KojoExprText): EmitResult {
      return `WHILE {${test.text}}`;
    },
    whileFooter(): EmitResult {
      return 'WEND';
    },
    repeatHeader(count: KojoExprText): EmitResult {
      return `REPEAT {${count.text}}`;
    },
    repeatFooter(): EmitResult {
      return 'REND';
    },
    forEachHeader(collection: KojoExprText): EmitResult {
      return `FOREACH {${collection.text}}`;
    },
    forEachFooter(): EmitResult {
      return 'NEXT';
    },
    /**
     * `@巡` 主链落点（伪引擎的**结构编码**，不是 ERB）：每个绑定一行，循环体原样嵌入。
     * core 测试据此断言"索引循环由 backend 出、绑定名改写正确"，不把 ERB 形状拖进 core。
     */
    forEachLoop(request: ForEachEmitRequest): EmitResult {
      const lines: string[] = [`FOREACH|${request.plan.kind}|${request.plan.collection}`];
      for (const binding of request.plan.bindings) lines.push(`BIND|${binding.name}|${binding.slot}`);
      for (const line of request.body) lines.push(line);
      lines.push('FOREACH.END');
      return lines;
    },
  },
});

/** backend 也是数据：装载时深冻结一次（与 adapter 同口径） */
function freezeBackend<T extends KojoEmitBackend>(backend: T): T {
  return deepFreeze(backend);
}
