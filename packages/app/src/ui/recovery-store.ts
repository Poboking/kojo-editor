/**
 * 崩溃恢复内容的进程内中转站（2026-10-16 退出/崩溃守护批）。
 *
 * 形态照 `jump-to-state` / `view-state-store` 的模块单例族：App 在启动判定出
 * 崩溃恢复后把快照内容放进这里，EditorPane 首次为某路径建 model 时**取即删**地
 * 领走——EditorPane 不需要为恢复新增 prop 链（ProjectView 不必改线），恢复也
 **永不自动写游戏目录**：内容装回 model 就地作为未保存脏内容，存不存由用户决定。
 */

export interface RecoveredFileContent {
  text: string;
  encoding: string;
  eol: string;
}

let store = new Map<string, RecoveredFileContent>();

/** 启动判定后一次性注入（覆盖式：旧残留清掉） */
export function setRecoveredContents(entries: ReadonlyArray<{ path: string } & RecoveredFileContent>): void {
  store = new Map(entries.map((e) => [e.path, { text: e.text, encoding: e.encoding, eol: e.eol }]));
}

/** 取即删：EditorPane 建 model 时领走（领走后内容只活在 model 里，由 autosave/用户保存接管后续） */
export function takeRecoveredContent(path: string): RecoveredFileContent | null {
  const v = store.get(path);
  if (!v) return null;
  store.delete(path);
  return v;
}

/**
 * 非消费读取（2026-10 恢复注入竞态批）：注入方在**提交闸之前**只能用这颗——
 * "取即删"发生在 await 前，快速切换（cancelled）后的重跑会领到 null，
 * 恢复内容随即被按读盘语义洗成"干净"（app ate my work 主案发现场）。
 * 消费时机由 `dropRecoveredContent` 决定；池侧基线钉 0 兜住"重跑复用已建 model"的分岔。
 */
export function peekRecoveredContent(path: string): RecoveredFileContent | null {
  return store.get(path) ?? null;
}

/** 提交后消费（与 `peekRecoveredContent` 配对）：快照内容确实已落进 model 并钉好基线才删 */
export function dropRecoveredContent(path: string): void {
  store.delete(path);
}

/** 尚未领走的恢复路径（恢复合并进标签集用；不消费） */
export function recoveredPaths(): string[] {
  return [...store.keys()];
}

/** 丢弃恢复（用户点了"丢弃"） */
export function clearRecoveredContents(): void {
  store.clear();
}
