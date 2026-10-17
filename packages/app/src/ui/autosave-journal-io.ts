import { tauriBridge } from '../bridge/tauri-bridge';
import type { JournalIo } from './autosave-journal';

/**
 * journal IO 适配（退出/崩溃守护批）：Tauri bridge 直写 appData——appData 在 Rust
 * 写允许域内恒可写，**不经 kernel io**（那条链 assertWritable 游戏路径 + 触发备份
 * 轮换，都不是快照该走的路）。只在 Tauri 壳被调用（engine 仅在 isTauri() 下装配）。
 *
 * 独立成文件：`autosave-journal.ts` 引擎本体零 React 零 Tauri（IO 靠注入），
 * 这段 bridge 依赖不能回流进引擎模块。
 */
export const journalIo: JournalIo = {
  readTextFile: async (p) => {
    try {
      if (!(await tauriBridge.exists(p))) return undefined;
      return new TextDecoder().decode(await tauriBridge.readFileBytes(p));
    } catch {
      return undefined; // 读不动按缺失算：恢复决策宁可保守降级，不让兜底数据炸启动
    }
  },
  writeTextFile: async (p, text) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (i > 0) await tauriBridge.ensureDir(p.slice(0, i));
    await tauriBridge.writeFileBytes(p, new TextEncoder().encode(text));
  },
  removeFile: async (p) => {
    try {
      await tauriBridge.removeFile(p);
    } catch {
      // 幂等清理：文件不在/删不掉都不值得出声（下次快照会覆盖出一致状态）
    }
  },
};
