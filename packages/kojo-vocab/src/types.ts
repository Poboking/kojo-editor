/**
 * 转译器内部类型（非契约；消费者只用 `plugin-api/sugar.ts`）。
 */

import type { AliasValue, SugarDiagnostic, SugarNode, SugarSourceSpan } from '@kojo/plugin-api';

/** 别名表条目（含只读性——`isReadonlyAlias` 的镜像，避免每次重新判定） */
export interface AliasEntry {
  value: AliasValue;
  /** 只读 = 角色引用 / 字面量（规范 §3.1 表） */
  readonly: boolean;
  /** 声明处所在源行（诊断与源映射用） */
  line: number;
}

/** 文件级别名表（规范 §3.1 ③：不跨文件） */
export type AliasTable = ReadonlyMap<string, AliasEntry>;

/**
 * 变量字典查询（由 game adapter 提供；转译器只消费，不解释游戏知识）。
 *
 * - `resolveFamily(name)`：给定变量**名字**（中文/日文/英文均可），返回所属
 *   变量族（`CFLAG` / `TALENT` / `ABL` / …）；未收录 → undefined
 *   （用于 `她的X` 属性解析）。**归属只认来源的前两层**：主表名 → 追加名表名，
 *   作者自定具名常量（契约 `VariableInfo.source === 'const'`）不参与——它与 `nameAt`
 *   的往返自证不同源，参与就会把主表的归属抢走（ALS-R1，读数见 `index.ts`）；
 * - `resolve(ident)`：给定**裸标识符**（如作者写的 `DAY` / `TFLAG:193`），
 *   返回可直接嵌入 ERB 的原文；未收录 → undefined
 *   （用于正文裸标识符）。
 */
export interface DictionaryLookup {
  resolveFamily(name: string): string | undefined;
  resolve(ident: string): string | undefined;
  /**
   * **反向**查询（**可选能力**）：给定变量族与索引（编号或具名），返回该索引的**名称**。
   *
   * 用途：升糖**投影**的"属性反糖"——把 `{CFLAG:TARGET:1088}` 显示成 `{她的好感度}`，
   * 让不熟悉 EraBasic 的读者能读懂那串数字是什么。
   *
   * 缺省（字典不支持反向）= 该文件不做属性反糖（投影照常工作，数字保持数字——**不猜**）。
   * 未收录 / 该族无名称表 → undefined，同样原样保留。
   */
  nameAt?(family: string, index: string): string | undefined;
  /**
   * **家族头中文别名**（**可选能力**；D2 批）：表层中文别名 → 引擎变量族头
   * （`现在` → `NOWEX`）。**表住 adapter**（游戏知识），转译器只查表不解释。
   *
   * 用途：写侧把表达式 / 段条件里的中文族头替换成引擎族头（`现在:噴乳` → `NOWEX:噴乳`）。
   *
   * 缺省（字典不支持 / adapter 未提供）= **不做**：未登记的名字一律原样保留（**不猜**）。
   * 作者若用同名**别名**（`别名 现在 = …`）声明了该名，作者别名优先、本表不替换。
   */
  familyAlias?(name: string): string | undefined;
  /**
   * **家族头中文别名的反向**（**可选能力**；D2 批）：引擎变量族头 → 表层中文别名
   * （`NOWEX` → `现在`）。与 `familyAlias` 同一张 adapter 表的反向查询。
   *
   * 用途：升糖**投影**的族头中文化——文本体与表达式里的 `NOWEX:噴乳` 渲染成
   * `现在：噴乳`（全角冒号，对齐糖面写法）。
   *
   * 缺省（字典不支持 / adapter 未提供）= **不做**：未登记的族头一律原样保留（**不猜**）。
   */
  familyAliasReverse?(family: string): string | undefined;
  /**
   * **具名索引核对**（**可选能力**；P-10③「族头直通改条件校验」）。
   *
   * 背景：`resolve` 历史上**只看族头**——族头认得出就整串放行 ⇒ 名称段拼错
   * （`NOWEX:噴乳乳瞎写`）零诊断静默进产物，违铁律 4「内核不静默」。本方法把
   * 「族表在位、但该名称查无」这一件事单独问一次，**不改写产物**（放行原文仍归
   * 调用方决定），调用方据此报 warning（生效点 expression.ts 的族引用放行处）。
   *
   * 口径（与 `service.ts` 头注的既有宽容一致）：
   * - **有表则校验**：该族（含引擎层同名表别名，见 `index.ts`）的名称表在位，
   *   且名称段非纯数字 ⇒ 查表，查无 = 返回判据；
   * - **无表则放行**：字典未注入 / 该族无机读名称表 / 未打开工程 ⇒ `undefined`，
   *   行为与今天逐字相同（"没打开项目不许误伤"）；
   * - 形态不认（三段及以上的作用域写法、族头不属引擎变量族）⇒ 同样 `undefined`。
   *   注意本方法只看**交进来的那串**：扫描器把 `SOURCE:LOCAL:(LOCAL:1)` 这类三段形
   *   在 `:` 处截断后只剩两段，本方法会照判——**放行由调用方负责**（生效点
   *   `expression.ts`：截断处仍是 `:` 就不调用本核对，ALS-R2）。
   *
   * 返回 `{ family, name }` = 「族 `family` 的名称表在位，但 `name` 不在表内」；
   * 返回 `undefined` = 无判据（放行）。
   */
  unlistedFamilyName?(ident: string): { family: string; name: string } | undefined;
  /**
   * **位名 → 引擎位号**（**可选能力**；v1.8 位名表层语法）。
   *
   * 背景：位槽（`获取标记(X, 名)` 的第二实参 / 语句形 `设置标记 X, 名` 的位号段）
   * 历史上只认数字 / 表达式——写**裸中文位名**会落到既有 `unknown-identifier`（error）。
   * 本方法让位槽能写「该变量**自身**位表里的位名」（如 `CFLAG:TARGET:1` 的 `接吻`）。
   *
   * 判据（**同族同号**、零游戏知识）：`variableName` = 第一实参经既有
   * `resolveFamily` / `resolve` 链路解析出的**变量引用**（`CFLAG:TARGET:1` / `TFLAG:193`）；
   * `bitLabel` = 作者写的位名。实现须**只在该变量自身的 `bits` 表**内按 `label`
   * **整词精确**匹配，返回 `VariableInfo.bits[].bit`（引擎位号，**不是**文本）；
   * 该位表里查无 / 同一位表内多枚同名（歧义）⇒ `undefined`（**不猜**）。
   *
   * 缺省（字典不支持 / 未打开工程）= **不做**：位槽里的裸名照旧走既有
   * `unknown-identifier`（**行为与今天逐字相同**）。
   */
  bitIndexOf?(variableName: string, bitLabel: string): number | undefined;
  /**
   * **槽位原名 → 中文名**（**可选能力**；ZH-N 接线批）：契约
   * `VariableSchema.slotCn` 的**逐字转发**——表（游戏汉化词典 + 名称表编号换算）只住
   * adapter，本包零解释、零第二份。
   *
   * 用途：native 行显示形给槽位补中文注记（`NOWEX:噴乳` → `现在:噴乳（喷乳）`，
   * `native-display/statement.ts` 消费）。
   *
   * 缺省（字典不支持 / adapter 未提供）= **不标注记**：槽位保持原名（**不猜**，
   * 与 `familyAliasReverse` 同一条红线）。
   */
  slotCn?(engineFamilyUpper: string, jpName: string): string | undefined;
}

/**
 * 随机块的**产物模式**（P-4）。
 *
 * - `default`（缺省）：`LOCAL = RAND:n` + `SELECTCASE LOCAL`（库内旧主流，golden 冻结口径）；
 * - `direct`：文件头写 `随机形: 直出` 时启用，产物直出 `SELECTCASE RAND:n`（与库内
 *   近年主流逐字同构，且不占 `LOCAL` 槽）。
 *
 * 模式挂在随机节点上（parser 附 `_randomShape`，codegen 读），不走契约字段——
 * 契约 `RandomBlock` 只描述候选序列、不含槽位决策，本项同理是**转译器内部决策**。
 */
export type RandomShape = 'default' | 'direct';

/**
 * `心形：` 连续块（P-7）——转译器**内部** AST 节点（非契约）。
 *
 * 块体是文本行序列，**逐行**产 `CALL HPH_PRINT(@"…","<mode>")`（模式字母规则与
 * 单行形 `心形 「…」` 完全一致，复用 codegen 的 `heartCall`）。故块体每行在 AST 里
 * 就是一枚 `heartLine`（引号内 = 台词 = 非 `d` 模式；不带引号 = 旁白 = `d` 模式）。
 *
 * 契约的 `SugarNode` 联合是闭集，本节点不进契约——与 `_randomShape` 一样是
 * **转译器内部决策**（消费方按 `kind` 判别时遇未知 kind 应原样忽略）。
 */
export interface HeartBlock {
  kind: 'heartBlock';
  /** 块体：文本行节点（`heartLine`）；注释原样保留（"注释不能丢"） */
  body: SugarNode[];
  /**
   * **宁缺勿编**：块体混入任何非文本行（控制流 / 赋值 / 别的块 / 缩进异常）⇒ true。
   * codegen 据此**一条字节都不产**（照 §5.3「不生成半成品」的 fail-closed 口径）。
   */
  readonly _invalid: boolean;
  loc: SugarSourceSpan;
}

/** 诊断收集器（parse 与 codegen 共用；保证 `internal` 绝不静默） */
export interface DiagnosticSink {
  report(diag: SugarDiagnostic): void;
  /** 已收集的诊断（按源位置排序由调用方负责） */
  all(): SugarDiagnostic[];
}
