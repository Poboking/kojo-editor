/**
 * 基础类型：贯穿内核与插件的最小公共词表。
 */

/** 可释放对象 */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** 取消订阅函数 */
export type Unsubscribe = () => void;

/** 日志器（内核注入给插件，输出会带插件 id 前缀） */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
