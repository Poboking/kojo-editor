/**
 * **第三列假 adapter**（SDK B5a 的终态判据：新增一个包 ⇒ 多一列）。
 *
 * 这一个文件是"最小 profile"的样子：**只有数据**，没有识别规则、没有 IO、没有 Monaco，
 * 也没有任何 real 游戏名。它唯一的作用是证明 SDK 的入口面确实够用——
 * 一份 `GameAdapter` + 一枚 `KojoEmitBackend` 就能进 conformance 跑同一批共享用例，
 * 而套件与 CLI 一个字都不用改（注册表是数据）。
 *
 * ## 它与 eraTW / eraFL 的**共有事实**（共享用例之所以能共享）
 *
 * - `# 机 初见`：三方言都有这场首见事件（引擎 token 各不相同，落点属"各自事实"）；
 * - 文本 / 空行 / 条件 / 表 / 池 / 模板 / 随机 / 原生 / 程序层：2.0 语义面，与方言无关；
 * - 取色 `SETCOLOR` / `RESETCOLOR` 与 `colorMode = 'D'`：Emuera 系引擎的落点形状。
 *
 * ## 它**不是**什么
 *
 * 不是可发布适配器：`gameFingerprint` / `storageClasses` / `capability` 全按 core 的
 * 抽象 fixture 派生，只把"共享用例真的踩到的那几格"换成本列自己的值
 * （事件表 / 程序层开关 / 演出面 / profile）。任何真实工程都不会用它识别。
 */
import type { CarrierBinding, GameAdapter } from '@kojo/kojo-core';
import { FIXTURE_ADAPTER, freezeAdapter } from '@kojo/kojo-core';

/** 本列自己的事件表：只有一个共享事件，引擎 token 是本列自己的名字（不借 eraTW / eraFL） */
export const DEMO_EVENT_CATALOG = Object.freeze({
  defaultEvent: null,
  events: Object.freeze([
    Object.freeze({
      event: '初见',
      engine: 'DEMO_FIRST',
      args: Object.freeze([]),
      dispatch: 'engine-dispatch' as const,
      priority: 'emuera-buckets' as const,
      guard: null,
      forced: true,
      weavable: true,
    }),
  ]),
});

/**
 * 最小 profile：**只声明共享用例踩到的落点**。
 *
 * - `colorMode: 'D'`：与 eraTW / eraFL 同为 Emuera 系（D 系打印可用）；
 *   换成 `'plain'` 会让共享本文的 `PRINTFORMDW` / `PRINTFORMW` 分家——那不是"最小"，是"不同"。
 * - `randStyle: 'printdata'` / `poolStyle: 'if'`：三方言同口径。
 * - `features`：program 层取共享用例真用到的四项（数组 / 循环 / 跳转 / 重复）；
 *   递归与 `@巡` 不声明——共享用例里没有它们（那属"各自事实"）。
 */
/**
 * 本列的载体归属（LAU-D4 车 ① 的"新方言夹具"半格）。
 *
 * 形状取 Emuera 系与 eraTW 同侧的事实：`# 机` 从 `.kojo2` 成立（inline），发射产物落
 * `ERB/**`（erb）；两格都省略 `validates` = 四类事实全量。这一列存在的意义就是把
 * "第三门方言带 carriers 进来"钉成**只加数据**：`resolveDialectBinding` 与归属闸
 * （`tests/carriers.test.ts`）吃三列走同一张表，套件、CLI、宿主一个字不改。
 */
export const DEMO_CARRIERS: readonly CarrierBinding[] = Object.freeze([
  Object.freeze({ carrier: 'erb' as const, glob: 'ERB/**/*.ERB' }),
  Object.freeze({ carrier: 'inline' as const, glob: '**/*.kojo2' }),
]);

export const DEMO_GAME_ADAPTER: GameAdapter = freezeAdapter({
  ...FIXTURE_ADAPTER,
  id: 'demo',
  version: '2.0.0',
  eventCatalog: DEMO_EVENT_CATALOG,
  carriers: DEMO_CARRIERS,
  profile: Object.freeze({
    narrationColor: 'default',
    dialogueColor: 'default',
    waitDefault: 'wait',
    colorMode: 'D',
    poolStyle: 'if',
    randStyle: 'printdata',
    features: Object.freeze(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat'] as const),
  }),
  presentation: Object.freeze({
    heart: null,
    color: Object.freeze({ setColor: 'SETCOLOR', resetColor: 'RESETCOLOR', hexPrefix: '0x' }),
    face: null,
    options: null,
  }),
  programFeatures: Object.freeze({
    arrays: true,
    while: true,
    goto: true,
    recursion: false,
    foreach: false,
    repeat: true,
  }),
  foreachCollections: null,
});
