/**
 * 口上 XML 服务（`kojo.xml`）——索引生命周期 + 订阅。
 *
 * 为什么单独一个服务而不是把索引塞进 `GameProject`：索引是**派生数据**，会随保存
 * 失效、随项目关闭清空；`GameProject` 是不透明载荷（内核视角），往里塞会逼内核
 * 理解"什么时候该重算"。服务形态让消费方（面板 / 诊断 / 预览）各自取用、各自订阅。
 *
 * 读盘口径：批量（`readBytesMany` 每批 64 份），因为一次进项目要读 293 份；
 * 逐份 `readBytes` 会变成 293 趟 IPC（PITFALLS 里那条"批量读"教训）。
 */
import type {
  FileIO,
  KojoXmlComSpec,
  KojoXmlFile,
  KojoXmlIndex,
  KojoXmlSchema,
  KojoXmlService,
  Logger,
} from '@kojo/plugin-api';
import { decodeKojoXmlBytes } from './encoding';
import { buildKojoXmlIndex } from './index-build';
import { parseKojoXmlText } from './parse';
import { buildKojoXmlSchema } from './schema';
import { previewKojoCommand } from '../preview';

/** 一次批量读多少份（与内核批量 IO 的分批口径同量级） */
const READ_BATCH = 64;

export interface KojoXmlServiceDeps {
  readonly io: FileIO;
  readonly log: Logger;
  /** 口上 XML 搜索根（通常 `[<root>/ERB/口上]`）；每次 `refresh()` 现取，支持换项目 */
  readonly roots: () => readonly string[];
  /** 路径 → 角色号（缺省按「父目录名以 `{数字}_` 开头」解析） */
  readonly charaNoOfPath?: (path: string) => number | null;
  /** `com` 数字表（装载时从 `CSV/Train.csv` 注入；缺席 = 只用符号表） */
  readonly comTable?: () => readonly KojoXmlComSpec[] | null;
}

/** 缺省角色号解析：父目录 `1099_うふふお姉さん` → 1099 */
export function charaNoFromKojoPath(path: string): number | null {
  const parts = path.split(/[\\/]/);
  // 从后往前找第一个以「数字_」开头的段：文件本身可能叫 `1099_xxx.xml`，也可能是
  // `KOJO_K1099_COM.xml` 放在 `1099_xxx/` 里——两种都要认
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]!;
    const dirHit = /^(\d{1,4})_/.exec(seg);
    if (dirHit) return Number(dirHit[1]);
    // `\b` 在 `KOJO_K1000_COM` 里不成立（`_` 也是词字符）⇒ 用显式分隔符判据
    const fileHit = /^KOJO_K(\d{1,4})(?:_|\.|$)/i.exec(seg);
    if (fileHit) return Number(fileHit[1]);
  }
  return null;
}

export interface KojoXmlServiceHandle extends KojoXmlService {
  /** 清空索引并断开订阅（项目关闭 / 插件停用时调） */
  dispose(): void;
}

export function createKojoXmlService(deps: KojoXmlServiceDeps): KojoXmlServiceHandle {
  const { io, log } = deps;
  const listeners = new Set<() => void>();
  let current: KojoXmlIndex | null = null;
  let byPath = new Map<string, KojoXmlFile>();
  /** 并发 refresh 的序号：只有最后一次的结果落地（先发后到不许覆盖新结果） */
  let generation = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        log.warn(`口上 XML 索引订阅者抛错（已隔离）：${String(err)}`);
      }
    }
  };

  /** 列出全部 XML（不剪枝：`walkDir` 的 filter 跨进程会丢，见 PITFALLS） */
  const listXmlFiles = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const root of deps.roots()) {
      let entries;
      try {
        entries = await io.walkDir(root, { includeDirs: false });
      } catch (err) {
        log.warn(`口上 XML 目录扫描失败（跳过该根）：${root} — ${String(err)}`);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (/\.xml$/i.test(entry.name)) out.push(entry.path);
      }
    }
    // 去重 + 稳定排序：同一份文件被两个根覆盖时只算一次
    return [...new Set(out)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };

  const parseOne = (path: string, bytes: Uint8Array): KojoXmlFile => {
    const { text, encoding } = decodeKojoXmlBytes(bytes);
    const charaNo = (deps.charaNoOfPath ?? charaNoFromKojoPath)(path);
    return parseKojoXmlText({ path, text, encoding, charaNo });
  };

  const refresh = async (): Promise<KojoXmlIndex | null> => {
    const mine = ++generation;
    const paths = await listXmlFiles();
    if (paths.length === 0) {
      // **空结果也是结果，同样不许迟到覆盖**：这一次扫到 0 份（作者刚删光、或扫描发生在
      // 目录还没建好时），并不代表更新的那次扫描没扫出东西——没有这道闸，一次迟到的空扫
      // 会把别人刚建好的索引清空，面板就变成"明明有 XML 却显示没有"。
      if (mine !== generation) return current;
      // 没有 XML 的工程不是错误：清空索引并通知，面板显示"这个工程没有口上 XML"
      current = null;
      byPath = new Map();
      notify();
      return null;
    }

    const files: KojoXmlFile[] = [];
    let readFailed = 0;
    for (let i = 0; i < paths.length; i += READ_BATCH) {
      const batch = paths.slice(i, i + READ_BATCH);
      let bytesList: Array<Uint8Array | null>;
      try {
        bytesList = await io.readBytesMany(batch);
      } catch (err) {
        // 整批失败：逐份降级重试（单份坏文件不该让整批消失）
        log.warn(`口上 XML 批量读失败，转逐份重试：${String(err)}`);
        bytesList = await Promise.all(
          batch.map(async (p) => {
            try {
              return await io.readBytes(p);
            } catch {
              return null;
            }
          }),
        );
      }
      for (let k = 0; k < batch.length; k++) {
        const path = batch[k]!;
        const bytes = bytesList[k];
        if (!bytes) {
          readFailed++;
          log.warn(`口上 XML 读取失败（跳过）：${path}`);
          continue;
        }
        files.push(parseOne(path, bytes));
      }
    }

    // 迟到的 refresh 不覆盖新结果（作者连点两次刷新时，先发的那次可能后到）
    if (mine !== generation) return current;

    const index = buildKojoXmlIndex(files);
    current = index;
    byPath = new Map(index.files.map((f) => [f.path, f]));
    log.info(
      `口上 XML 索引：${index.files.length} 份 / ${index.commandCount} 条口上` +
        `（${index.byChara.size} 个角色；诊断 ${index.diagnostics.length} 条` +
        `${readFailed > 0 ? `；读取失败 ${readFailed} 份` : ''}）`,
    );
    notify();
    return index;
  };

  return {
    index: () => current,
    file: (path: string) => byPath.get(path) ?? null,
    schema: (): KojoXmlSchema | null => {
      // 规格与索引无关：即使还没扫，宿主也该能拿属性表画补全
      let extra: readonly KojoXmlComSpec[] | null = null;
      try {
        extra = deps.comTable?.() ?? null;
      } catch (err) {
        log.warn(`口上 XML 的 com 表获取失败（按符号表降级）：${String(err)}`);
      }
      return buildKojoXmlSchema(extra);
    },
    refresh,
    /**
     * 预览一条口上。**纯函数转接**：不读盘、不碰索引，所以未加载 / 已关项目时照样能用
     * （面板从索引里取到 `KojoXmlCommand` 再传进来，索引没了自然也就没有条目可预览）。
     */
    preview: (command, ctx) => previewKojoCommand(command, ctx ?? {}),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      current = null;
      byPath = new Map();
      generation++;
    },
  };
}
