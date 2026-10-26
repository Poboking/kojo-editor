/**
 * eraAV 口上域的**目录级事实**（`loadProject` 那一次 `listDir` 的产物，纯数据）。
 *
 * 为什么要单独立一个模块并交给约定规则以闭包取用：契约的
 * `ConventionCheckContext` 只有 project / index / readFile / log / policy，**没有列目录能力**，
 * 而非 ERB 文件也根本进不了 `ErbIndex`——这两条规则要的正是"域里有哪些条目"这件事。
 * 先例：eraTW 把主路由表以 `getProtocol()` 闭包递给 `kojo-call-slot-coverage`
 * （`packages/plugins/eratw-adapter/src/conventions.ts:500`），不另开一条 IO 通道。
 *
 * 本类型同时是 `search.scope` 的输入（`./search-scope.ts`）：本作的角色检索范围 = 该角色的
 * **那一份口上文件**，所以「哪个号对应哪份文件」只在这一次 `listDir` 里算，两处共用同一份事实。
 */

/** 口上域内的一份角色口上文件（`no` 取到即视为"这个号有一份口上"） */
export interface EraavKojoFileEntry {
  /** 文件名里的角色号（`EVENT_K01_…` → 1；只是文件名事实，不参与函数路由） */
  readonly no: number;
  /** 绝对路径 */
  readonly path: string;
  /** 文件名里的名称段（日文原文）；`charaIndex` 缺席时作标签兜底 */
  readonly label: string;
}

/** 一次 `loadProject` 的口上域扫描结果 */
export interface EraavKojoScan {
  /** 解析出口上文件名的条目（实测真盘 17 份 ⇒ 17 条） */
  readonly kojoFiles: readonly EraavKojoFileEntry[];
  /** 域内的非 ERB/ERH 文件（实测真盘 1 份：`想达成调教结束后表白效果.txt`） */
  readonly nonErbFiles: readonly string[];
}
