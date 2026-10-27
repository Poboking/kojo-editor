import type {
  InlineCompletionCandidate,
  InlineCompletionOutcome,
  InlineCompletionRequest,
  InlineCompletionSourceContribution,
} from '@kojo/plugin-api';
import type { ErbIndex, ErbIndexState } from '@kojo/plugin-api';
import type { NameCatalog } from './catalog';
import { declaredCatalog, declaredDirectives, functionCatalog, probePrefix, uniqueNameFor } from './catalog';
import type { ErbNameSlot, SlotCatalog } from './slot-shape';
import { erbNameSlotAt } from './slot-shape';

/**
 * 本地候选源的**一次调用**怎么走（三态 + 弃权的落地点）。
 *
 * 顺序是判据，不是风格：
 * 1. **语言不归我 ⇒ 立刻弃权**（`undefined`，一个 `await` 都不产生）；
 * 2. **位置不是名字槽 ⇒ 同样弃权**——"这一格不是写名字的地方"是"没看过"而不是"看过没有"；
 * 3. 事实缺席（`erb.parser` 没激活 / 没开项目 / 索引还在建）⇒ `failed`，
 *    `note` 在这份对象里就写好（三段：哪段没成 + 为什么 + 可重试）；
 * 4. 事实齐 ⇒ 算唯一性：唯一 ⇒ `candidates`（逐字回带 `version`）；
 *    零条或多条 ⇒ `no-completion`（看过、确认这一格给不出**唯一**答案）。
 *
 * 时间预算与取消在 1 之后每道关口查一次（`expired`），过期一律 `no-completion`：
 * 本包**永不**发 `partial` —— 唯一性的自证要求把整个前缀区间数完，数到一半的结论
 * 不是"部分结果"而是"没有结论"。`partial` 那一档留给外部模型源（见 `plugin.ts` 头注）。
 */

/** 槽 `completion.source` 里本贡献的 id（宿主侧会再加 `pluginId` 命名空间） */
export const LOCAL_SOURCE_ID = 'local-name-slot';

/** 候选上的 `sourceId`（供方内唯一；与槽 id 同值，便于作者面把"这条来自哪家"对上） */
export const LOCAL_CANDIDATE_SOURCE_ID = 'local-name-slot';

/** 形状①②③ 的作者面说明（`note` 由本包生成，宿主原文显示、不解析） */
const SHAPE_LABEL: Record<ErbNameSlot['shape'], string> = {
  definition: '函数定义名',
  call: '调用目标名',
  declaration: '声明名',
};

/** 名录种类 → 作者面叫法（出现在 `note` 里，说的是"依据哪份名录"） */
const CATALOG_LABEL: Record<SlotCatalog, string> = {
  functions: '项目函数名录',
  declared: '项目 #DIM 声明名录',
};

export interface LocalProviderDeps {
  /** 当前索引（`null` = 还没建好；由插件按请求时刻现读，不许缓存快照） */
  currentIndex(): ErbIndex | null;
  /**
   * 名录的提供方（`erb.parser`）是否在场。
   *
   * 为什么要单独一枚，而不是拿 `currentIndex() === null` 一并说：
   * "提供方没激活"与"提供方在、但这一轮还没建好"是**两句不同的话**——前者要去看插件状态面板，
   * 后者只要等几秒。把它们写成同一条 `note`，作者就分不清该做哪一件（铁律 4 的"可见"
   * 指的是可见到**能据此行动**的程度）。缺省 = 视作在场（测试与旧接线零改动）。
   */
  serviceAvailable?(): boolean;
  /** 索引这一轮的可查事实（additive 可选；缺席只是少一句原因，不影响判据） */
  indexState?(): ErbIndexState | null | undefined;
  /** 时钟（测试注入用；生产缺省 `Date.now`） */
  now?(): number;
}

export interface LocalProviderOptions {
  /** 最小已打字面长度（缺省 1：空前缀无从谈"唯一"） */
  readonly minTypedLength?: number;
  /** 是否服务声明名那一形状（缺省 true；关掉用于对照命中率） */
  readonly enableDeclarationShape?: boolean;
}

/** 一次调用的完整轨迹（`provideInline` 的返回 + 内部计数，供状态面与语料活闸读数） */
export interface LocalTrace {
  readonly outcome: InlineCompletionOutcome | undefined;
  /** 命中的形状名（弃权时可能没有） */
  readonly shape?: ErbNameSlot['shape'];
  /** 前缀在名录里的真实命中条数（封顶 3，只为读数不为判据） */
  readonly hits?: number;
}

const NO_COMPLETION: InlineCompletionOutcome = { state: 'no-completion' };

/**
 * 是否已经过期/被叫停。
 *
 * `timeoutMs <= 0` 也算过期：契约把预算交给宿主裁，"这趟已经没有预算了"是本包唯一
 * 读得懂的信号（此时结果即便算对也没有观众）。
 */
function expired(request: InlineCompletionRequest, startedAt: number, now: () => number): boolean {
  if (request.signal?.aborted === true) return true;
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) return true;
  return now() - startedAt >= request.timeoutMs;
}

/** 失败态的三段话（哪段没成 + 为什么 + 可重试）；`note` 必须在这里就说人话，不留给宿主拼 */
function fail(
  stage: 'context' | 'fetch',
  reason: string,
  note: string,
  detail?: string,
): InlineCompletionOutcome {
  return {
    state: 'failed',
    stage,
    reason,
    note,
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
  };
}

/** 索引这一轮的读数只有 provider 真的暴露了函数才取（桩实现零改动仍可用） */
function readIndexState(deps: LocalProviderDeps): ErbIndexState | null {
  const read = deps.indexState;
  if (typeof read !== 'function') return null;
  try {
    return read.call(deps) ?? null;
  } catch {
    return null; // 事实面读不到只是少一句原因，判据不在这条腿上
  }
}

/**
 * ERB 方言的语言 id。
 *
 * **这是本包唯一一处复写的宿主常量**：那个 id 现在住在 `app/src/monaco/erb-language.ts`
 * 的 `ERB_LANGUAGE_ID`，而插件不许 import 宿主。已交组长裁决（回执里点名）：
 * 单一真源该落在 `plugin-api/erb-ext.ts`（那张表已经是"哪些文件算 ERB 方言"的钦定位置，
 * 加一枚语言 id 常量是同一条纪律的自然延伸）。
 * 在那之前，`languageId` 认不上时**退回扩展名**判据（`isErbDialectPath`），
 * 与 `@kojo/plugin-kojo-lang` 的 `isKojo2Request` 同一先例：有 id 以 id 为准，无 id 才看扩展名。
 */
export const ERB_LANGUAGE_IDS: readonly string[] = ['kojo-erb', 'erb'];

export function isServedLanguage(request: InlineCompletionRequest): boolean {
  if (typeof request.languageId === 'string' && request.languageId.length > 0) {
    return ERB_LANGUAGE_IDS.includes(request.languageId.toLowerCase());
  }
  return false;
}

/** 名录取哪一份（形状的归属名录，判据单源在 `catalog.ts`） */
function catalogOf(index: ErbIndex, kind: SlotCatalog): NameCatalog {
  return kind === 'functions' ? functionCatalog(index) : declaredCatalog(index);
}

function toCandidate(request: InlineCompletionRequest, slot: ErbNameSlot, name: string): InlineCompletionCandidate {
  return {
    sourceId: LOCAL_CANDIDATE_SOURCE_ID,
    range: {
      startLine: request.line,
      startColumn: slot.start + 1,
      endLine: request.line,
      endColumn: slot.end + 1,
    },
    insertText: name,
    kind: slot.catalog === 'functions' ? 'function' : 'variable',
    note: `${SHAPE_LABEL[slot.shape]}：前缀「${slot.typed}」在${CATALOG_LABEL[slot.catalog]}里只匹配到这一个名字`,
  };
}

function makeDepsFailsafe(deps: LocalProviderDeps): LocalProviderDeps {
  // "取名录这一步自己抛了"记成一枚在场标志：抛错的提供方与"没有提供方"对作者说的是
  // 同一句话（都不在场），而它和"名录还在建"必须分开（后者是等几秒，前者是去看插件状态）。
  let readThrew = false;
  return {
    ...deps,
    currentIndex: () => {
      try {
        return deps.currentIndex();
      } catch {
        readThrew = true;
        return null;
      }
    },
    serviceAvailable: () => !readThrew && deps.serviceAvailable?.() !== false,
  };
}

/**
 * 纯函数的一趟判定（**测试与语料活闸打的就是这一枚**；`provideInline` 只是它的异步外壳）。
 *
 * 返回 `{ outcome, shape?, hits? }`：`shape`/`hits` 只为读数存在，不影响 `outcome`。
 */
export function localInlineCompletion(
  request: InlineCompletionRequest,
  rawDeps: LocalProviderDeps,
  options: LocalProviderOptions = {},
  startedAt = Date.now(),
): LocalTrace {
  const deps = makeDepsFailsafe(rawDeps);
  const now = deps.now ?? Date.now;
  // —— 1. 语言 ——
  if (!isServedLanguage(request)) return { outcome: undefined };

  // —— 2. 位置（要先读索引里的指令词表，所以事实缺席与位置判定的先后见下） ——
  const minTyped = options.minTypedLength ?? 1;
  const index = deps.currentIndex();

  // —— 3. 事实缺席（放在位置之后判、但**在名录之前**：位置不成立的弃权不必等名录） ——
  const slot = index === null ? null : erbNameSlotAt(request.prefix, request.suffix, declaredDirectives(index));
  if (index === null) {
    // 名录缺席的三种原因各有各的话术；判据只有一个：本包没有名录，一条候选都不许给
    if (request.project === null) {
      return {
        outcome: fail(
          'context',
          'no-project',
          '本地补全没出字：这一格需要「项目函数名录」，而现在没有打开任何项目。打开项目后会自动重试，也可以按一次主动补全再问一遍。',
        ),
      };
    }
    if (deps.serviceAvailable?.() === false) {
      return {
        outcome: fail(
          'fetch',
          'parser-absent',
          '本地补全没出字：名录的提供方（ERB 解析器）不在场，这一格没有任何依据可算。可在插件状态里确认它是否失败，恢复后自动重试。',
        ),
      };
    }
    const state = readIndexState(deps);
    const phase = state?.phase ?? 'unknown';
    // 读数只在提供方陈述了事实时才写进话术（`indexState?` 是契约里可选的一枚，缺席就少一句，
    // 不编一个"已扫 0 个文件"出来）
    const progress = state === null ? '' : `，已扫 ${String(state.filesScanned)} 个文件 / ${String(state.functions)} 个名字`;
    const errorNote = state?.error === undefined || state.error.length === 0 ? '' : `（原因：${state.error}）`;
    return {
      outcome: fail(
        'fetch',
        `index-${phase}`,
        `本地补全没出字：这个项目的名录还没建好（当前阶段 ${phase}${progress}）。稍等片刻或再敲一个字会自动重问${errorNote}。`,
      ),
    };
  }
  if (slot === null) return { outcome: undefined }; // —— 2'. 位置不归我 ——
  if (slot.typed.length < minTyped) {
    // 空槽：不是"没有唯一答案"，而是"还没开始写"。弃权，别把一整个名录的开场白塞给作者。
    return { outcome: undefined, shape: slot.shape };
  }
  if (slot.shape === 'declaration' && options.enableDeclarationShape === false) {
    return { outcome: undefined, shape: slot.shape };
  }
  if (expired(request, startedAt, now)) return { outcome: NO_COMPLETION, shape: slot.shape };

  const catalog = catalogOf(index, slot.catalog);
  const probe = probePrefix(catalog, slot.typed, 3);
  const hits = probe.truncated ? 3 : probe.hits.length;
  const unique = uniqueNameFor(catalog, slot.typed);
  if (unique === undefined) {
    // 看过、按窗口算过、给不出唯一答案 ⇒ 这一档才是"确认没有"
    return { outcome: NO_COMPLETION, shape: slot.shape, hits };
  }
  // 过期复验：名录算完之后作者已经走了一步 ⇒ 这一批没有观众（宿主侧还会按 version 再丢一次）
  if (expired(request, startedAt, now)) return { outcome: NO_COMPLETION, shape: slot.shape, hits };
  return {
    outcome: {
      state: 'candidates',
      version: request.version,
      candidates: [toCandidate(request, slot, unique)],
    },
    shape: slot.shape,
    hits: 1,
  };
}

/** 契约要求的贡献对象（`id` / `title` / `order` / `pluginId` 由插件侧填，宿主补 pluginId） */
export function createLocalContribution(
  deps: LocalProviderDeps,
  options: LocalProviderOptions = {},
): InlineCompletionSourceContribution {
  return {
    id: LOCAL_SOURCE_ID,
    order: LOCAL_SOURCE_ORDER,
    title: '本地名录候选（唯一命中才给）',
    provideInline: async (request) => localInlineCompletion(request, deps, options).outcome,
  };
}

/**
 * 排队序：**本地先、模型后**（第一家给出 `candidates` 就是答案，所以本地命中即"今天不出网"）。
 * 取值与"外部模型源该填多少"的整套理由写在 `plugin.ts` 头注的「第二家怎么进来」。
 */
export const LOCAL_SOURCE_ORDER = 10;
