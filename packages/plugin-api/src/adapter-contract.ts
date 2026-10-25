/**
 * 适配器契约的新增类型（**type-only 叶子**）。
 *
 * 为什么单独成文件：这几枚类型只出现在**类型位置**（接口字段、方法签名），
 * 值侧一处也没有。按「叶子纪律」（进首屏的代码只许引叶子），它们若留在
 * `game.ts` / `conventions.ts` 里，会把注释与声明的字节数算进**开机静态图**
 * （那两个文件在欢迎页图上）。放进独立叶子并以 `export type` 回出，
 * 打包器与静态图都看不见它——类型本就不该在运行期占字节。
 */

/**
 * `detect` 的结果。
 * 老适配器可直接返回 `boolean`（等价于 `{ matched }`）；新适配器带上证据，
 * 多适配器同时认领时内核能把「谁因为什么认领」原样抛给宿主。
 * `evidence` 只用于诊断展示，**不参与取舍**——取舍只有「零命中 / 单命中 / 多命中报冲突」。
 */
export interface AdapterDetection {
  readonly matched: boolean;
  readonly evidence?: readonly string[];
}

export type AdapterDetectResult = boolean | AdapterDetection;

/**
 * 占位符的**人类可读语义**（只影响显示，不改变拼接行为）。
 *
 * 行为仍由 `indexKind` 决定；这里回答的是「作者看到的这个尾号到底是什么」——
 * 同一个 `{i}` 在 A 游戏是指令编号、在 B 游戏可能是 `CFLAG` 里的口上模式。
 * 展示层只照原文打印，不解释、不据此做任何换算。
 */
export interface KojoSlotSemantics {
  /** `{i}` 槽 */
  readonly index?: { readonly label: string; readonly detail?: string };
  /** `{n}` 槽 */
  readonly chara?: { readonly label: string; readonly detail?: string };
}

/**
 * 内置通用规则的**静默策略**（additive；只对声明它的适配器生效）。
 *
 * 有些族的「同名函数多处定义」是引擎语义的一部分（逐角色各写一份），
 * 全报成 info 会把真正需要作者处理的重复淹掉。策略是**声明式数据**，不是回调：
 * 规则 id + 名字集 + 理由；引擎只按名字判等，不读正文、不认游戏。
 */
export interface ConventionSuppression {
  /** 被收敛的规则 id（内置通用规则，如 `erb.duplicate-function`） */
  readonly ruleId: string;
  /** 归一化函数名精确集（`ErbFunctionRef.normalizedName` 口径，大小写不敏感） */
  readonly names?: readonly string[];
  /** 或按名字正则（与 `names` 任一命中即收敛；写正则时请加锚点） */
  readonly namePattern?: string;
  /** 人类可读理由（**必填**：报告里照原话汇总，不静默） */
  readonly reason: string;
}

export type ConventionPolicy = readonly ConventionSuppression[];

/** 冲突诊断里的一枚认领者（displayName 给界面用，evidence 给排查用） */
export interface AdapterConflictCandidate {
  readonly adapterId: string;
  readonly displayName: string;
  readonly evidence: readonly string[];
}
