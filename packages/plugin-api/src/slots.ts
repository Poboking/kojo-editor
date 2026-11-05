/**
 * 槽位契约里**仅存的运行时**（2026-11-06 契约字节闸治理：纯类型整批搬到 `./slots-types`）。
 *
 * 为什么本文件非留在开机图里不可：下面三张 `as const` 表是**跨包共用的值**——宿主空态
 * 按钮 / 工具栏引用命令 id，宿主 legend 取词表子集。桶 `index.ts` 必须值导出它们，
 * 值导出决定模块图 ⇒ 本文件在 PS-10 开机静态图内（读数见 `docs/STATE.md` PS-10 行）。
 *
 * **这里只许放运行期**：任何 `interface` / `type` / 辅助类型别名都必须住 `slots-types.ts`。
 * 类型面（100+ 条）从那里出、桶里走 `export type`（会被擦除，不进图）。
 */

/**
 * **跨包共用的知名命令 id**（单一真源；与 `WellKnownServices` 同款模式）。
 *
 * 场景：宿主（如空态按钮）与插件（注册者自身 / 工具栏引用）需要引用**同一个**
 * 命令 id 字符串。硬编码两份会漂移（改名时只改一处，另一处静默失效）——统一从
 * 本表取。additive：新增命令在此登记；**不改名、不删除**（同事件兼容性承诺）。
 */
export const WellKnownCommands = {
  /** 新建口上文件（注册者 `ui-sugar-editor`；宿主空态按钮按 id 引用，缺席即隐藏） */
  NewKojoFile: 'kojo.newKojoFile',
} as const;

/** 语义着色的中性类别（词表；宿主 legend 是其子集，名字对不上即不着色 + 可见退化） */
export const EDITOR_SEMANTIC_TOKEN_TYPES = ['function', 'variable', 'parameter'] as const;

/** 语义着色的中性修饰（同上口径；`declaration` = 声明位，`readonly` = 写了会编译不过的只读名字） */
export const EDITOR_SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'readonly'] as const;
