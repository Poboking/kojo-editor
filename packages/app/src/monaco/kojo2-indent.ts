/**
 * Kojo 2.0 的**打字期结构增强层**（K2-FOLD-INDENT 批起，K2-INDENT-BRACKETS 批扩到括号）——
 * **B3i（2026-10-30）起判据整块住 `@kojo/kojo-lang/indent`，本文件只剩 Monaco 装配与翻译**：
 * - on-type formatter 的注册（触发字符 `\n` + 成对记号的开括号，**必须同一枚 provider**）；
 * - 判据 → Monaco 的翻译：包内 1 基行号区间 → `TextEdit` / `IRange`；
 * - `installKojo2IndentConfigFromWorker(monaco, { getClient })`：把 worker 的 `indents` 回复
 *   经 `kojo2IndentConfigWith` 送进 `setLanguageConfiguration`（K2-INDENT-WIRE 批）。
 *
 * **SDK-B5b 车 6（2026-10-31）定案**：这条 on-type 腿是**引擎面**，不是语言判断，
 * **不进** `SlotServiceKind` / 槽腿工厂（理由与被否掉的 (b) 路线写在
 * {@link installKojo2IndentOnTypeProvider} 的头注）；能力矩阵把 `Indent` 记作 `self`。
 * 两枚安装器分工不变：本文件 `IndentOnType`（引擎面）+ `IndentConfigFromWorker`（宿主事实）。
 *
 * 判据（回车层级表 / 同级容器 / `@原生` 围栏 / `?` 分支 / 表体 / 块体 / 围栏内自动闭合守卫）
 * 一条都不在本文件：逐字住在 `@kojo/kojo-lang/indent`，那是**纯函数叶子**（零 Monaco、
 * 零 React、零 DOM、零 IO），与 B3c–B3f 搬走的六批判据同形。本条车道（B3i）的全部内容就是
 * 把 `kojo2IndentAfterLine` / 行首空白替换 / 自动闭合守卫的判据搬进包，宿主只保留调用点。
 *
 * ## 与静态规则的分工（B4 之后）
 *
 * `@kojo/kojo-lang/language-config` 交**静态规则数据**（`onEnterRules` /
 * `indentationRules`），经槽 `ui.monaco.language` 由供方交给宿主落进 Monaco——规则数据
 * 已经在包里，本文件连"哪两条正则"都不再写（基底规则的投影也是包内的
 * `KOJO2_BASE_INDENT_RULES`）。静态规则只拿得到"当前行文本"：`@原生` 围栏状态是跨行事实、
 * 缩进是否在 4 空格栅格上也只有整篇词法知道 ⇒ 回车这一面需要**上下文判据**，那正是
 * `@kojo/kojo-lang/indent` 的 `kojo2IndentAfterLine`。两层不冲突：静态规则管按键瞬间的近似
 * 手感，本层在 `formatOnType` 开启时校正到精确值（不一致才发一条 edit）。
 *
 * ## 与 `queries/v2/indents.scm` 的分工（K2-INDENT-BRACKETS 之后）
 *
 * 那份查询**已经有真捕获**（`@indent.increase` / `@indent.align`），worker 把它翻成宿主的
 * `KojoStructureIndentRules` 三条腿（`kojo2-worker.ts::indentRulesFromCaptures`），宿主侧
 * 由 {@link installKojo2IndentConfigFromWorker} 合并进语言配置（只加不撤）——那是**结构层
 * 的静态规则**，与上面的语言面静态规则同一条 Monaco 通路。
 *
 * ## 注册
 *
 * {@link installKojo2IndentOnTypeProvider} 只给 `kojo2` 语言 id 注册 on-type formatter，
 * **无条件装配**（K2-SURFACE-DEFAULT：改缓冲的回车缩进也算语言面）。触发字符两族：`\n`（回车缩进，跟随 v1 `installEnterIndenter`）与
 * `KOJO2_PAIRS` 里的开括号（围栏内自动闭合守卫）。**必须同一枚 provider**：Monaco 只派发
 * 注册表里第一枚 provider 的触发字符（`format.js::getOnTypeFormattingEdits`），拆成两枚会让
 * 其中一族静默失效。
 *
 * Monaco 只在 `editor.formatOnType` 开启时派发——所以它是**增强层**，按键瞬间的手感仍由
 * `@kojo/kojo-lang/language-config` 的 `onEnterRules` 与语言配置的 `autoClosingPairs` 兜；两条腿不冲突。
 * 围栏内自动闭合这条守卫因此也有上限：`formatOnType` 关掉的作者仍会在围栏里拿到自动闭合
 * （语言配置没有围栏上下文，`notIn` 只认 `string` / `comment` / `regex`）。
 *
 * {@link installKojo2IndentConfigFromWorker} 不注册 provider（Monaco 没有"缩进规则
 * provider"接口），只持有 `setLanguageConfiguration` 的账：挂点是 `kojo2-semantic.ts` 的
 * 安装器，语义着色**成功**拿到捕获之后惰性触发（见本文件「结构规则 → 语言配置」段）。
 *
 * 失败面：判不准 / 模型已释放 / 词法抛错 ⇒ `[]`（一个字符都不改），绝不抛进 Monaco。
 */
import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID, KOJO2_PAIRS } from './kojo2-language';
// B3i：判据整块在包叶子。本文件只取三样东西——两枚纯函数答案（行首空白替换 / 自动闭合
// 删除目标）与基底规则数据；正则、词表、词法一条都不在这里。
import {
  KOJO2_BASE_INDENT_RULES,
  kojo2AutoCloseTargetAt,
  kojo2IndentReplacementAt,
} from '@kojo/kojo-lang/indent';
import { mergeIndentConfig, type MergedIndentConfig } from './tree-sitter/indent';
import type {
  Kojo2IndentRules,
  Kojo2IndentsReply,
  Kojo2WorkerResult,
} from './tree-sitter/kojo2-worker-protocol';

/* ============================== 触发字符（provider 配置） ============================== */

/**
 * on-type 触发字符：只有换行。跟随 v1 `installEnterIndenter` 的同一条口径——
 * 触发面越窄，越不会与作者的手动缩进打架（打别的字不该触发缩进校正）。
 */
export const KOJO2_INDENT_TRIGGER_CHARS: readonly string[] = Object.freeze(['\n']);

/**
 * 自动闭合的**开括号**触发字符（与语言配置的 `autoClosingPairs` 同一张表 `KOJO2_PAIRS`）。
 *
 * 为什么要走 on-type：Monaco 的静态 `autoClosingPairs` 只有 `notIn: ['string'|'comment'|'regex']`
 * 三档，`@原生` 围栏是 tokenizer 状态、不在那三档里 ⇒ 语言配置挡不住围栏内的自动补。
 * 围栏上下文（`lex` 的 `kind === 'native'`）只有本模块的 on-type 层拿得到，所以由这里在
 * 同一枚 provider 里处理（Monaco 的 on-type 只派发**注册表里第一枚** provider 的触发字符，
 * 拆成第二枚 provider 会让回车缩进或本档之一静默失效——`format.js::getOnTypeFormattingEdits`）。
 */
export const KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS: readonly string[] = Object.freeze([
  ...new Set(KOJO2_PAIRS.map(([open]) => open)),
]);

/* ============================== 契约 → Monaco（翻译层） ============================== */

/**
 * 一次 on-type 请求要落的编辑（导出仅为可单测：宿主只经 provider 调它）。
 *
 * 本函数**只做翻译**：判据（只接新行的空行 / 只改行首空白 / 算得出且不一样才作答 / 幂等）
 * 全在包叶子的 `kojo2IndentReplacementAt`；这里把包内 1 基列区间翻成 Monaco `TextEdit`。
 * 判据答 `null` ⇒ `[]`（一个字符都不改）。
 */
export function kojo2IndentEditsAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.TextEdit[] {
  const line = position.lineNumber;
  if (!Number.isInteger(line) || line <= 1) return [];
  if (typeof model.getLanguageId === 'function' && model.getLanguageId() !== KOJO2_LANGUAGE_ID) {
    return [];
  }
  let text: string;
  try {
    text = model.getValue();
  } catch {
    return []; // 模型已释放 / 桩 model 取不到文：判不了 ⇒ 不动
  }
  if (typeof text !== 'string') return [];
  const replacement = kojo2IndentReplacementAt(text, line);
  if (replacement === null) return [];
  return [
    {
      range: {
        startLineNumber: replacement.line,
        startColumn: replacement.startColumn,
        endLineNumber: replacement.line,
        endColumn: replacement.endColumn,
      },
      text: replacement.text,
    },
  ];
}

/**
 * 自动闭合的**围栏守卫**（导出仅为可单测：宿主只经 provider 调它）。
 *
 * 本函数**只做翻译**：触发指纹（开括号 + 紧贴的闭括号）、`@原生` 围栏上下文、成对记号表
 * 全在包叶子的 `kojo2AutoCloseTargetAt`；这里把包内 1 基列区间翻成一条删除 `TextEdit`。
 * 判据答 `null` ⇒ `[]`（自动闭合照旧，本守卫一个字都不碰）。
 *
 * 已知上限（写出来而不是藏着）：这是 on-type 层，Monaco 只在 `formatOnType` 开启时派发；
 * 关掉它的作者在围栏内仍会拿到自动闭合（语言配置那一格没有围栏上下文，`notIn` 也不认
 * tokenizer 状态）。`@原生` 原文保真优先：宁可少补，不许改写围栏里的字节。
 */
export function kojo2AutoCloseGuardEditsAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  trigger: string,
): Monaco.languages.TextEdit[] {
  if (typeof trigger !== 'string' || trigger.length !== 1) return [];
  if (typeof model.getLanguageId === 'function' && model.getLanguageId() !== KOJO2_LANGUAGE_ID) {
    return [];
  }
  const line = position.lineNumber;
  const column = position.column;
  if (!Number.isInteger(line) || line < 1) return [];
  if (!Number.isInteger(column) || column < 2) return [];
  let text: string;
  try {
    text = model.getValue();
  } catch {
    return [];
  }
  if (typeof text !== 'string') return [];
  const target = kojo2AutoCloseTargetAt(text, line, column, trigger);
  if (target === null) return [];
  return [
    {
      range: {
        startLineNumber: target.line,
        startColumn: target.startColumn,
        endLineNumber: target.line,
        endColumn: target.endColumn,
      },
      text: '',
    },
  ];
}

/**
 * worker 的 `indents` 规则 → 宿主可直接 `setLanguageConfiguration` 的合并结果（additive 便捷口）。
 *
 * 这就是"宿主 `mergeIndentConfig` 消费"那一步：基底用包内的 `KOJO2_BASE_INDENT_RULES`
 * （`@原生` 栏头 / 行尾全角冒号），结构层规则只**加**在后面；`null` = worker 没给规则 /
 * 全空 ⇒ 宿主不重发语言配置（与 v1 `syncIndentConfig` 同口径，空规则 = 一个字都不发）。
 *
 * 纯函数、零注册：接线在 {@link installKojo2IndentConfigFromWorker}（宿主挂点是
 * `kojo2-semantic.ts` 的安装器：语义着色成功拿到捕获之后惰性触发）。
 */
export function kojo2IndentConfigWith(
  rules: Kojo2IndentRules | null | undefined,
): MergedIndentConfig | null {
  return mergeIndentConfig(KOJO2_BASE_INDENT_RULES, rules);
}

/* ============================== 结构规则 → 语言配置（K2-INDENT-WIRE） ============================== */

/**
 * 三条腿各自的规则上限。
 *
 * 规则按**语言**累积（`setLanguageConfiguration` 是语言级的，不是文档级的）：一篇文档的
 * `# 对照表` 与另一篇的 `# 池` 都该进同一份配置，否则"打开 A 再打开 B"会把 A 的块头规则弄丢。
 * 但累积必须有界——词形家族只有十几枚，128 已比现实宽一个量级；病态文档（真词表外的一堆
 * 伪块头）不许把语言配置撑爆。
 */
export const KOJO2_INDENT_CONFIG_MAX_PATTERNS = 128;

/**
 * 缩进规则来源（worker 客户端的最小依赖面；真 `Kojo2WorkerClient` 与测试替身都满足）。
 *
 * `indents` 是**可选**的：只买语义面的替身 / 老客户端没有这一格 ⇒ 本层零改动
 * （不是"发一条空规则"，是一条都不发）。
 */
export interface Kojo2IndentRulesSource {
  indents?(
    text: string,
    version: number,
    oldTreeId?: string,
  ): Promise<Kojo2WorkerResult<Kojo2IndentsReply>>;
}

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2IndentConfigDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2IndentRulesSource | null | Promise<Kojo2IndentRulesSource | null>;
  /** 一次性告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
}

/**
 * 结构规则 → 语言配置的**句柄**（不注册 provider：本层只持有 `setLanguageConfiguration`
 * 的那一枚 disposable）。
 */
export interface Kojo2IndentConfigHandle {
  /**
   * 惰性触发一轮（宿主在**语义着色 provider 成功拿到捕获之后**调它；同一 model 同一版本
   * 只发一次 worker 请求）。返回 Promise 只为可单测——宿主 `void` 掉即可。
   *
   * `oldTreeId` = 语义着色那一轮刚解出来的树号：worker 的查询请求带它就能直接查（文本逐字
   * 相同 ⇒ 不重解），不带也能跑（worker 会自己解一棵）。这是**省一次 parse** 的增量，
   * 不是正确性前提。
   */
  request(model: Monaco.editor.ITextModel, oldTreeId?: string): Promise<boolean>;
  /** `request` 的别名（同一条队列；导出只为可读的调用点） */
  applyFor(model: Monaco.editor.ITextModel, oldTreeId?: string): Promise<boolean>;
  /** 幂等：撤掉本层写过的语言配置，之后不再发请求 / 不再写配置 */
  dispose(): void;
}

/**
 * 缺省客户端：懒到第一次真请求才把 worker 模块拉进来（与 `kojo2-semantic.ts` 同一条惰性口径）。
 */
async function defaultIndentWorkerClient(): Promise<Kojo2IndentRulesSource | null> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/** 规则腿的运行时兜底：只留非空字符串（假客户端 / 版本错位都不许把配置写坏） */
function readRuleLeg(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const pattern of value) {
    if (typeof pattern === 'string' && pattern.length > 0) out.push(pattern);
  }
  return out;
}

/** 累积规则（三条腿各自去重 + 封顶；存量一条都不撤） */
function absorbPatterns(target: Set<string>, patterns: readonly string[], limit: number): void {
  for (const pattern of patterns) {
    if (target.size >= limit) return;
    target.add(pattern);
  }
}

/**
 * 造一枚"结构规则 → 语言配置"的同步器（**不注册任何 provider**）。
 *
 * ## 挂点为什么是"语义着色成功之后"
 *
 * Monaco 的 `setLanguageConfiguration` 是语言级的，但规则只能由 worker 在**某一篇文本**上
 * 跑 `indents` 查询得到；而宿主手里唯一"每篇都过一遍、且已经证明 worker 可用"的位置，就是
 * 语义着色 provider 的成功分支（`kojo2-semantic.ts`，它已经拿到 model + 版本号）。
 * 于是：worker 不回复 / 查询缺席 ⇒ 着色那条链先降级，本层连请求都不会发 ⇒ **零改动**。
 *
 * ## 纪律（每一条都有对应测试）
 *
 * - **只交两个属性**：`onEnterRules` + `indentationRules`（property 级合并；注释 / 括号 /
 *   `wordPattern` 一概不写 ⇒ 继续走 `kojo2LanguageConfiguration` 那一份）；
 * - **同 key 只发一次**：key = `mergeIndentConfig` 的规则指纹（含基底两格）；同一份规则
 *   第二次回复不再重写语言配置（每次重注册会让 Monaco 整批编辑器重算缩进）；
 * - **规则按语言累积**：后开的文档只**加**自己那批块头词形，从不撤前一篇的；
 * - **失败零改动**：worker 不可用 / 超时 / 查询缺席 / 回复坏形 / 取客户端抛错
 *   ⇒ 不写配置，**也不撤**已有配置（旧配置继续生效）；
 * - **同一 model 同一版本只问一次**（Monaco 停笔 / 滚动会反复重问 provider）；
 * - **不抛进 Monaco**：所有异常只让这一轮不写配置；
 * - {@link Kojo2IndentConfigHandle.dispose} 幂等：只撤一次自己写过的那枚配置。
 *
 * 与切流开关无关（K2-SURFACE-DEFAULT：缩进属语言面）；规则只依赖 worker 的 `indents` 查询是否可用。
 */
export function createKojo2IndentConfigSync(
  monaco: typeof Monaco,
  deps: Kojo2IndentConfigDeps = {},
): Kojo2IndentConfigHandle {
  const getClient = deps.getClient ?? defaultIndentWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const warned = new Set<string>();
  /** 语言级累积（三条腿各自去重 + 封顶） */
  const increase = new Set<string>();
  const enter = new Set<string>();
  const decrease = new Set<string>();
  /** model → 已经问过的版本号（同版本不重发请求） */
  const requested = new WeakMap<Monaco.editor.ITextModel, number>();
  /** 已写进语言配置的规则指纹（`MergedIndentConfig.key`） */
  let appliedKey: string | null = null;
  /** 本层写过的那枚语言配置的 disposable（只撤自己写的那一份） */
  let registration: Monaco.IDisposable | null = null;
  /** 一条队列：两条回复并发时，"后写的那份"必须包含"先写的那份"（语言配置不能倒退） */
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      warn(message);
    } catch {
      /* 告警出口自己炸了不该把本层带下水 */
    }
  };

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const versionOf = (model: Monaco.editor.ITextModel): number => {
    try {
      const version = model.getVersionId();
      return typeof version === 'number' && Number.isFinite(version) ? Math.trunc(version) : 0;
    } catch {
      return 0;
    }
  };

  /** 只交 `onEnterRules` + `indentationRules`（两个属性，property 级合并） */
  const writeConfig = (merged: MergedIndentConfig): Monaco.IDisposable | null => {
    let result: Monaco.IDisposable | undefined;
    try {
      result = monaco.languages.setLanguageConfiguration(KOJO2_LANGUAGE_ID, {
        onEnterRules: merged.onEnterRules.map((rule) => ({
          beforeText: rule.beforeText,
          action: { indentAction: monaco.languages.IndentAction.Indent },
        })),
        indentationRules: {
          increaseIndentPattern: merged.increaseIndentPattern,
          decreaseIndentPattern: merged.decreaseIndentPattern,
          // 基底这两格是"整对象替换"里最容易被顺手撤掉的部分：原样带出（2.0 基底没有 ⇒ 不写）
          ...(merged.indentNextLinePattern === undefined
            ? {}
            : { indentNextLinePattern: merged.indentNextLinePattern }),
          ...(merged.unIndentedLinePattern === undefined
            ? {}
            : { unIndentedLinePattern: merged.unIndentedLinePattern }),
        },
      });
    } catch (error: unknown) {
      // 写不进去 = 这一轮零改动（旧配置还在：registration 只在写成功之后才换）
      warnOnce(
        `write:${error instanceof Error ? error.message : String(error)}`,
        `[kojo2-indent] 无法写语言配置（本轮保持原样，编辑器不受影响）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (result !== null && typeof result === 'object' && typeof result.dispose === 'function') {
      return result;
    }
    // 桩 Monaco / 老版本可能不交 disposable：本层没有可撤的账，给一枚空句柄占位
    return { dispose: () => undefined };
  };

  const applyOnce = async (
    model: Monaco.editor.ITextModel,
    oldTreeId?: string,
  ): Promise<boolean> => {
    if (disposed) return false;
    if (typeof model.isDisposed === 'function' && model.isDisposed()) return false;
    // 只服务 2.0 语言：`setLanguageConfiguration` 会改**整门语言**的缩进手感，认错语言就是事故
    const languageId = typeof model.getLanguageId === 'function' ? model.getLanguageId() : KOJO2_LANGUAGE_ID;
    if (languageId !== KOJO2_LANGUAGE_ID) return false;
    let text: string;
    try {
      text = model.getValue();
    } catch {
      return false; // 模型已释放 / 桩 model 取不到文：一个字都不改
    }
    if (typeof text !== 'string' || text.trim().length === 0) return false;

    let client: Kojo2IndentRulesSource | null;
    try {
      client = await getClient();
    } catch (error: unknown) {
      warnOnce(
        `client:${error instanceof Error ? error.message : String(error)}`,
        `[kojo2-indent] 取不到结构 worker（本轮不写缩进配置，原有回车规则不变）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (disposed) return false;
    if (client === null || client === undefined) return false;
    const indents = client.indents;
    // 只买语义面的客户端 / 老替身没有这一格 ⇒ 本层零改动（一条规则都不发）
    if (typeof indents !== 'function') return false;

    let reply: Kojo2WorkerResult<Kojo2IndentsReply>;
    try {
      // `oldTreeId` = 语义着色刚解出来的那棵树：worker 文本逐字相同 ⇒ 直接查，不重解
      reply = await indents.call(client, text, versionOf(model), oldTreeId);
    } catch (error: unknown) {
      warnOnce(
        `request:${error instanceof Error ? error.message : String(error)}`,
        `[kojo2-indent] indents 请求抛错（本轮不写缩进配置）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (disposed) return false;
    if (reply === null || typeof reply !== 'object' || reply.ok !== true) {
      const reason = reply !== null && typeof reply === 'object' && 'reason' in reply ? String(reply.reason) : 'unknown';
      warnOnce(
        `worker:${reason}`,
        `[kojo2-indent] 结构层没有给出缩进规则（${reason}）⇒ 保持既有语言配置不变`,
      );
      return false;
    }
    if (reply.value.type !== 'indents') return false;

    const rules = reply.value.rules as Partial<Kojo2IndentRules> | null | undefined;
    absorbPatterns(increase, readRuleLeg(rules?.increasePatterns), KOJO2_INDENT_CONFIG_MAX_PATTERNS);
    absorbPatterns(enter, readRuleLeg(rules?.enterPatterns), KOJO2_INDENT_CONFIG_MAX_PATTERNS);
    absorbPatterns(decrease, readRuleLeg(rules?.decreasePatterns), KOJO2_INDENT_CONFIG_MAX_PATTERNS);

    const merged = kojo2IndentConfigWith({
      increasePatterns: [...increase].sort(),
      decreasePatterns: [...decrease].sort(),
      enterPatterns: [...enter].sort(),
    });
    // `null` = 这份文档没有开体行（基底一条都在，但基底已经由语言注册写过了）⇒ 不重发
    if (merged === null) return false;
    if (merged.rejected > 0) {
      warnOnce(
        `rejected:${merged.rejected}:${merged.key}`,
        `[kojo2-indent] 结构层给了 ${merged.rejected} 条非法正则 ⇒ 这几条丢掉，其余规则照常生效`,
      );
    }
    if (merged.key === appliedKey) return false;

    const next = writeConfig(merged);
    if (next === null) return false;
    const previous = registration;
    registration = next;
    appliedKey = merged.key;
    // 新配置已经生效，才撤旧的那一枚（property 级合并：撤旧不会把新配置带走）
    try {
      previous?.dispose();
    } catch {
      /* 旧注册自己炸了：新配置已经生效，不影响结论 */
    }
    return true;
  };

  const request = (model: Monaco.editor.ITextModel, oldTreeId?: string): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (model === null || typeof model !== 'object') return Promise.resolve(false);
    const version = versionOf(model);
    if (requested.get(model) === version) return Promise.resolve(false);
    requested.set(model, version);
    return serialize(() => applyOnce(model, oldTreeId).catch(() => false));
  };

  return {
    request,
    applyFor: request,
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = registration;
      registration = null;
      appliedKey = null;
      try {
        current?.dispose();
      } catch {
        /* 撤注册失败不改结论：编辑器正在关，配置随语言服务一起走 */
      }
    },
  };
}

/**
 * 宿主挂点：把 worker `indents` 回复经 {@link kojo2IndentConfigWith} 送进
 * `setLanguageConfiguration('kojo2', { onEnterRules, indentationRules })`。
 *
 * **不注册 provider**（所以它天生是"零注册"）；宿主在语义着色 provider 成功拿到捕获
 * 之后调 `request(model)` 惰性触发（挂点在 `kojo2-semantic.ts` 的 `install` 里）。
 *
 * 缩进属**语言面**（K2-SURFACE-DEFAULT：改缓冲的回车缩进也算语言面）⇒ 不读切流开关。
 *
 * 为什么不做成 provider：Monaco 没有"缩进规则 provider"接口，规则只能写进语言配置；
 * 而语言配置是语言级的——本函数因此只持有那一枚 disposable 的账。
 */
export function installKojo2IndentConfigFromWorker(
  monaco: typeof Monaco,
  deps: Kojo2IndentConfigDeps = {},
): Kojo2IndentConfigHandle {
  return createKojo2IndentConfigSync(monaco, deps);
}

/**
 * 为 `kojo2` 语言注册回车缩进 formatter（**无条件**：缩进是语言面，阶段 `v1-only` 也照常生效）。
 *
 * ## 它为什么**不**是一条槽腿（SDK-B5b 车 6，2026-10-31 定为 (a) 路线）
 *
 * `SlotServiceKind` 里没有 `onType`，也不为它新开一格：on-type formatter 是 **Monaco 引擎面**
 * （`registerOnTypeFormattingEditProvider`），不是 `ui.editor.languageService` 的语言服务面。
 * 更关键的是它**没有可搬的判据与供方形状**：插件侧已把那三枚纯函数（`kojo2IndentReplacementAt`
 * / `kojo2AutoCloseTargetAt` / `KOJO2_BASE_INDENT_RULES`）交出来了，但槽协议里没有"回车请求"
 * 这一格——要"由插件供"就得先给契约加一条 on-type 请求，再让 ERB / kojo1 各自造一枚永远弃权的
 * 空供方（它们本就没有这条腿）。那不是"少写一点代码"，是把引擎面伪装成语言判断（还会让
 * `language-slot-conformance` 的供方台账凭空多两条无人认领的腿）。
 *
 * 所以定 (a)：**判据在包、注册与翻译在宿主**，并以名字把这条腿钉成"引擎面"——
 * `IndentOnType`（而不是笼统的 `IndentProvider`），与旁边的
 * {@link installKojo2IndentConfigFromWorker}（宿主事实：worker 的缩进规则 → 语言配置）分开记账。
 * 能力矩阵 `KOJO2_CAPABILITY_STATUS[Indent] = 'self'` 那一格与理由是同一份账。
 *
 * 返回的 disposable 幂等（注册只撤一次）；provider 体内任何异常都只让**这一轮**不改缩进。
 */
export function installKojo2IndentOnTypeProvider(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.OnTypeFormattingEditProvider = {
    // 一枚 provider 两条腿：`\n` 走回车缩进，开括号走围栏内自动闭合守卫（见两个触发字符常量的注释）
    autoFormatTriggerCharacters: [
      ...KOJO2_INDENT_TRIGGER_CHARS,
      ...KOJO2_AUTO_CLOSE_GUARD_TRIGGER_CHARS,
    ],
    provideOnTypeFormattingEdits(model, position, ch) {
      try {
        return ch === '\n'
          ? kojo2IndentEditsAt(model, position)
          : kojo2AutoCloseGuardEditsAt(model, position, ch);
      } catch {
        // 判不准 / 模型已释放 / 桩 model：一个字符都不改（缩进与围栏守卫都是增强层，不是唯一通路）
        return [];
      }
    },
  };
  // 注册失败没有额外资源可收（provider 无自有账）⇒ 直接外抛，由宿主的"全有或全无"回滚
  const registration = monaco.languages.registerOnTypeFormattingEditProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.dispose();
    },
  };
}
