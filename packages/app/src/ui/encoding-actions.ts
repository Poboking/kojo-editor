import type { FileEncoding, TextFile } from '@kojo/plugin-api';

/**
 * 显式编码读写（批次十 S2）。
 *
 * 编辑器此前的编码判据只有一条：**读时探测**。探测再好也会在两种现场认错——
 * ①同一个 GBK 文件被三族评分判成 Shift-JIS；②作者自己知道这份文件是什么编码。
 * 这两类现场需要的是"**按我指定的编码看 / 存**"，而不是让探测再猜一次。
 *
 * 本模块只做三件事（纯接线，编码/换行/写域判定全在内核单源）：
 * - {@link listEncodings}：可选编码清单（与 `@kojo/plugin-api` 的 `FileEncoding` 逐项对齐）；
 * - `reopenWithEncoding`：按指定编码重读盘上字节 → 把对应 Monaco model 的内容换成新解读，
 *   并把内核编码判据改成这份编码（下一次保存不回退到旧探测编码）；
 * - `saveWithEncoding`：取 model 文本 → 按目标编码编字节（内核 `encodeForSave`，保换行 /
 *   补 BOM）→ 走内核 `writeBytes`（合法写入域 + 原子写）→ `adoptEncoding` 同步内核判据。
 *
 * **不新增写盘通道**：写只经 `FileIO.writeBytes`，写允许域与第二道闸照旧由内核/宿主把关。
 * 也不碰 `readText` / `writeText` 的既有签名与「保编码 / 保换行」不变量——本模块是旁路能力。
 */

/** 编码菜单的一项（`id` 直接进内核显式编码入口，`label` 只给人看） */
export interface EncodingOption {
  readonly id: FileEncoding;
  readonly label: string;
}

/** 展示序 = `FileEncoding` 全集；`Record` 保证新增字面量时这里必须补一行（类型层面不会漏） */
const ENCODING_ORDER: readonly FileEncoding[] = [
  'utf-8',
  'utf-8-bom',
  'shift_jis',
  'gbk',
  'gb18030',
  'big5',
  'utf-16le',
  'utf-16be',
];

const ENCODING_LABELS: Record<FileEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 (BOM)',
  shift_jis: 'Shift-JIS（日文）',
  gbk: 'GBK（简体中文）',
  gb18030: 'GB18030（大字符集）',
  big5: 'Big5（繁体中文）',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
};

/** 可选编码清单（顺序固定；`id` 即内核 `FileEncoding`） */
export function listEncodings(): EncodingOption[] {
  return ENCODING_ORDER.map((id) => ({ id, label: ENCODING_LABELS[id] }));
}

/** 运行时校验：未知编码直接报错（与内核同一句原话口径，绝不静默按别的编码写） */
function assertKnownEncoding(encoding: FileEncoding): void {
  if (!(encoding in ENCODING_LABELS)) {
    throw new Error(`不支持的编码：${String(encoding)}（可选：${ENCODING_ORDER.join(' / ')}）`);
  }
}

/* ------------------------------ 注入端口 ------------------------------ */

/**
 * 本模块用到的 IO 面（`kernel.io` 的结构子集）。
 * 三个显式编码方法在契约里是**可选能力**（additive）：缺席时调用方得到一句明确报错，
 * 而不是退回探测（那正是本功能要消除的猜测）。
 */
export interface EncodingIoPort {
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readTextWithEncoding?: (path: string, encoding: FileEncoding) => Promise<TextFile>;
  encodeForSave?: (path: string, text: string, encoding: FileEncoding) => Promise<Uint8Array>;
  adoptEncoding?: (path: string, encoding: FileEncoding, bytes: Uint8Array) => void;
}

/**
 * 本模块用到的 model 面（`editorModelPool` 的结构子集）：
 * `liveModel` 只答**开着的标签**（PS-12-C 口径，冷档件不算），正合"重开当前文件"的语义。
 */
export interface EncodingModelPort {
  getValue(): string;
  setValue(text: string): void;
  getAlternativeVersionId(): number;
}

export interface EncodingModelPoolPort {
  liveModel(path: string): EncodingModelPort | undefined;
  setBaseline(path: string, version: number): void;
  setSavedBase(path: string, text: string): void;
}

export interface EncodingActionsDeps {
  /** 真身 = `kernel.io`（写域 / 原子写 / 缓存同步都在内核） */
  readonly io: EncodingIoPort;
  /** 真身 = `editorModelPool`（活动 model 的单源） */
  readonly models: EncodingModelPoolPort;
}

export interface EncodingActions {
  /**
   * 按指定编码重开当前文件：读盘字节 → 显式解码 → 替换 model 内容。
   *
   * 重开后的内容就是"盘上真相在指定编码下的样子"：基线/磁盘快照同步推进，
   * 于是标签立刻干净、保存时不把未改动的行当成编辑写回。
   *
   * @throws 文件未在本编辑器中打开，或 IO/model 实现缺少对应的显式编码能力
   */
  reopenWithEncoding(path: string, encoding: FileEncoding): Promise<TextFile>;
  /**
   * 按指定编码保存当前文件（model 当前文本）：编字节 → `writeBytes` → 内核判据跟随。
   * 落盘成功后才推进基线；失败原样上抛（调用方做可见提示）。
   *
   * @throws 文件未在本编辑器中打开，或 IO 实现缺少显式编码能力
   */
  saveWithEncoding(path: string, encoding: FileEncoding): Promise<void>;
}

function missingCapability(name: string): Error {
  return new Error(`当前 IO 实现不支持显式编码读写（缺少 ${name}；需要桌面壳/新版内核）`);
}

function requireLiveModel(
  models: EncodingModelPoolPort,
  path: string,
): EncodingModelPort {
  const model = models.liveModel(path);
  if (model === undefined) {
    throw new Error(`文件未在编辑器中打开，无法按显式编码处理：${path}`);
  }
  return model;
}

/** 装配三个动作（依赖注入；真身在壳层传 `kernel.io` + `editorModelPool`） */
export function createEncodingActions(deps: EncodingActionsDeps): EncodingActions {
  const { io, models } = deps;

  return {
    async reopenWithEncoding(path, encoding) {
      assertKnownEncoding(encoding);
      const readWith = io.readTextWithEncoding;
      if (readWith === undefined) throw missingCapability('readTextWithEncoding');
      // 先读盘、再取 model：读失败（文件被删/无权限）时一个字节都不动编辑器内容
      const tf = await readWith.call(io, path, encoding);
      const model = requireLiveModel(models, path);
      // 替换内容 = 把"按新编码解读的盘上真相"灌进现有 model（URI/词法/分屏引用全部保留）；
      // 随后把基线与磁盘快照推进到这份内容：切换本身不算编辑，标签不该因此变脏。
      model.setValue(tf.text);
      models.setBaseline(path, model.getAlternativeVersionId());
      models.setSavedBase(path, tf.text);
      return tf;
    },

    async saveWithEncoding(path, encoding) {
      assertKnownEncoding(encoding);
      const encode = io.encodeForSave;
      const adopt = io.adoptEncoding;
      if (encode === undefined) throw missingCapability('encodeForSave');
      if (adopt === undefined) throw missingCapability('adoptEncoding');
      const model = requireLiveModel(models, path);
      const text = model.getValue();
      // 文本 → 目标编码字节（内核保换行、UTF-16 补 BOM）→ 内核写通道（写域 + 原子写）
      const bytes = await encode.call(io, path, text, encoding);
      await io.writeBytes(path, bytes);
      // `writeBytes` 按探测回填判据（GBK 可能被判成 Shift-JIS）⇒ 用刚写的字节按目标编码纠正，
      // 下一次 preserve 保存才不会回退旧编码。
      adopt.call(io, path, encoding, bytes);
      // 落盘成功才推进基线：失败的保存必须保持"脏"，由调用方提示后重试。
      models.setBaseline(path, model.getAlternativeVersionId());
      models.setSavedBase(path, text);
    },
  };
}
