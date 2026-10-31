import type * as Monaco from './entry';
import './languages';
import {
  declaredSlotKinds,
  languageDescriptors,
  usesLegacyBridge,
  type LanguageDescriptor,
  type SlotServiceKind,
} from './language-registry';

/**
 * 一等语言通用语言服务的**唯一收口**：把一枚 provider 依次挂到每一门声明
 * `languageServices: true` 的语言 id 上，交回一枚把全部注册一起回收的句柄。
 *
 * 为什么值得单开一处（不是为了省行数）：「宿主侧能力对一等语言拉平」是一条**契约**，
 * 此前它被逐字抄在各 provider 文件的尾巴上。抄本一多，下一家新 provider 就只会被抄到
 * 其中一半——`erb-implementation` 当年正是这么只注册了 ERB，于是 `.kojo` 里 `Ctrl+F12`
 * 无人应答，而同一个位置 F12 答得出来。语言 id 清单现在只来自 descriptor 表：
 * 新增一门一等语言只需在 `languages.ts` 声明 `languageServices: true`，这 11 枚
 * provider 自动跟上。
 *
 * 注册顺序 = descriptor 顺序（ERB 先、Kojo 后，与收口前逐字一致；Monaco 按注册表
 * 顺序问 provider，别调）。保留面（JSON）不声明该能力，因此不会被挂上空 provider
 * 顶掉 Monaco 的缩进折叠。
 *
 * 两种写法同效（SDK-DIALECT，2026-10-31）：挂载判据读 `language-registry` 的两枚
 * helper——`languageServices` ↔ `services.legacyBridge`（旧桥全腿），`slotServices` ↔
 * `services.slot`（点名）。此前只读旧写法，照 `docs/DIALECT-AUTHORING.md` / descriptor 头注
 * 用新写法登记的方言会被静默漏挂（扩展路径上最贵的一种静默）。
 *
 * 不该套本函数的三类注册（各自有理由，别"顺手统一"）：
 * - **只给一门语言**的注册：`.kojo` 的区间格式化 / 回车缩进、ERB 的带闸区间格式化、
 *   两侧改名各一枚。一门语言一枚 provider；双注册会让输出取决于注册表顺序。
 * - 需要把**裸句柄**交回调用方的注册（`installEnterIndenter`、补全 assembly）——
 *   它们的返回值契约不是聚合 IDisposable。
 * - **同语言增补型**注册（用户片段补全，S18）：与内置补全**并存**而非替换，语言 id 清单由
 *   作者片段自身定（ERB / kojo2），不跟 descriptor 的 `languageServices` 铺满；套上来会
 *   把保留面也挂上一枚空 provider。
 *
 * `register` 收到的是**传进来的那个** `monaco` 对象：桩测试只桩它上面的一枚注册函数，
 * 所以注册必须经这个参数取函数，绝不许在别处另引一份 monaco 模块。
 */
export function registerForLanguageServices(
  monaco: typeof Monaco,
  register: (monaco: typeof Monaco, languageId: string) => Monaco.IDisposable,
  /**
   * 本枚 provider 对应的**能力名**（B2，可选、additive）。
   *
   * 给了它就顺带把「只声明了这一条槽腿」的语言（`slotServices`，见
   * `LanguageDescriptor`）也挂上；不给 = 只挂 `languageServices: true` 的语言，
   * 与 B2 之前**逐字相同**。缺省保持旧行为不是保守，是**必须**：那 11 枚里
   * 有几枚（折叠最典型）的空结果会顶掉 Monaco 内建行为，谁被挂上必须是写下来的。
   */
  kind?: SlotServiceKind,
  /**
   * 挂载口径（additive，SDK-B5b 车 5）：`namedOnly` = **只挂点名了这条腿的语言**，
   * 不铺 `languageServices: true` 的旧桥语言。
   *
   * 为什么要这一格：写面 / 迁移入口的腿（今天的 `codeAction`）只服务"把那门语言的改写
   * 交给插件"的那些语言；v1 的 ERB / kojo1 自带一枚合并 provider（`kojo-code-action.ts`），
   * 再给它们铺一枚**永远弃权**的 provider 既是白问一次、也会让"这门语言有几枚 💡 provider"
   * 从数据变成噪声。缺省 `false` = 旧行为逐字不变。
   */
  options: {
    readonly namedOnly?: boolean;
    /**
     * `excludeNamed` = **跳过**点名了这一格槽腿的语言（additive，ERB-PARITY G1）。
     *
     * 理由：一门语言把某条腿交给插件供方之后，**旧桥语言的自建 provider 必须让位**——
     * 否则同一门语言上会同时挂两枚同种 provider（Monaco 把两份悬停正文**同时**摊开，
     * 不是后者覆盖前者）。判据照样是 descriptor 的声明（`slotServices` / `services.slot`），
     * 不写任何语言 id：`hover` 这一格今天只有 ERB 点名，它的 legacy 悬停因此不再自挂，
     * 由共享收口那一枚应答。
     */
    readonly excludeNamed?: SlotServiceKind;
    /**
     * `alsoFor` = 旧桥语言之外**再挂上**这一格 descriptor 声明点名的语言（additive，
     * LAU-KOJO2-INLINE 2026-10-31）。
     *
     * 为什么需要它（而不是让这门语言去点名一条 `SlotServiceKind` 腿）：有些 Monaco 面
     * 的应答者住在**另一枚专用槽**、形状也与十四条语言服务腿不同（今天的行内续写：
     * 供方在 `completion.source`，注册面是 `registerInlineCompletionsProvider`）。
     * 它的"谁被挂上"照样必须是**写下来的 descriptor 事实**，而不是宿主按语言 id 分支——
     * 判据住在语言注册表（`declaresInlineCompletion`），这里只吃一枚谓词，零语言知识。
     * 缺省 = 不给 ⇒ 与加这一格之前逐字相同。
     */
    readonly alsoFor?: (descriptor: LanguageDescriptor) => boolean;
  } = {},
): Monaco.IDisposable {
  // B3d：逐门挂上时**半途抛错就回滚**。此前 `.map` 写在表达式里，第二门注册抛错会让
  // 第一门那枚 disposable 当场丢失（它只活在 map 的中间值里）——调用方再"撤回已挂上的"
  // 只能撤到零枚，泄漏一枚只在错误路径出现的 provider。改成显式循环 + 逐枚回滚。
  const subs: Monaco.IDisposable[] = [];
  try {
    for (const descriptor of languageDescriptors()) {
// 两种写法同效（SDK-DIALECT，2026-10-31）：`languageServices: true` / `services.legacyBridge`
      // 都是旧桥；`slotServices` / `services.slot` 都是点名。判据读语言注册表那两枚 helper——
      // 本文件不再自抄一份（此前只读旧写法，照指南用新写法登记的方言会被静默漏挂）。
      // `excludeNamed`（ERB-PARITY G1）：点名了该槽腿的语言让旧桥那枚退出，
      // 只影响"共享旧桥枚"，不影响点名腿自己的注册。
      const namesExcluded =
        options.excludeNamed !== undefined &&
        declaredSlotKinds(descriptor).includes(options.excludeNamed);
      const servesAll =
        options.namedOnly !== true && usesLegacyBridge(descriptor) && !namesExcluded;
      const namedBySlot = kind !== undefined && declaredSlotKinds(descriptor).includes(kind);
      const alsoDeclared = options.alsoFor?.(descriptor) === true;
      if (!servesAll && !namedBySlot && !alsoDeclared) continue;
      subs.push(register(monaco, descriptor.id));
    }
  } catch (error) {
    for (const sub of subs) {
      try {
        sub.dispose();
      } catch {
        /* 回滚期逐枚隔离：一枚撤不掉不许带走其余（错误原样外抛给调用方） */
      }
    }
    throw error;
  }
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
