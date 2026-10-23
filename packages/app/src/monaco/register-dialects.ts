import type * as Monaco from './entry';
import './languages';
import { languageDescriptors } from './language-registry';

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
): Monaco.IDisposable {
  const subs = languageDescriptors()
    .filter((descriptor) => descriptor.languageServices === true)
    .map((descriptor) => register(monaco, descriptor.id));
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
