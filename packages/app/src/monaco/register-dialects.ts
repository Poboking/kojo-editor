import type * as Monaco from './entry';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * 双方言注册的**唯一收口**：把一枚 provider 依次挂到 ERB 方言族与 `.kojo` 两个语言 id 上，
 * 交回一枚把两次注册一起回收的句柄。
 *
 * 为什么值得单开一处（不是为了省行数）：「宿主侧能力对两种语言拉平」是一条**契约**，
 * 此前它被逐字抄在各 provider 文件的尾巴上。抄本一多，下一家新 provider 就只会被抄到
 * 其中一半——`erb-implementation` 当年正是这么只注册了 ERB，于是 `.kojo` 里 `Ctrl+F12`
 * 无人应答，而同一个位置 F12 答得出来。语言 id 与注册顺序现在只写在这一个地方：
 * **先 ERB 后 `.kojo`**（既有语义，Monaco 按注册表顺序问 provider，别调）。
 *
 * 不该套本函数的两类注册（各自有理由，别"顺手统一"）：
 * - **只给一门语言**的注册：`.kojo` 的区间格式化 / 回车缩进、ERB 的带闸区间格式化、
 *   两侧改名各一枚。一门语言一枚 provider；双注册会让输出取决于注册表顺序。
 * - 需要把**裸句柄**交回调用方的注册（`installEnterIndenter`、补全 assembly）——
 *   它们的返回值契约不是聚合 IDisposable。
 *
 * `register` 收到的是**传进来的那个** `monaco` 对象：桩测试只桩它上面的一枚注册函数，
 * 所以注册必须经这个参数取函数，绝不许在别处另引一份 monaco 模块。
 */
export function registerForKojoDialects(
  monaco: typeof Monaco,
  register: (monaco: typeof Monaco, languageId: string) => Monaco.IDisposable,
): Monaco.IDisposable {
  const subs = [register(monaco, ERB_LANGUAGE_ID), register(monaco, KOJO_LANGUAGE_ID)];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
