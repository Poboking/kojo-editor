/**
 * 保真旁路（游戏无关；字节级 round-trip 的元数据通道）。
 *
 * 契约类型（`SnapshotArchive` / `ArchiveCharacterBlock`）由 plugin-api 冻结，
 * 本插件无权扩展字段；但解析产物需要携带三类"用户从未改动、却必须原样还原"
 * 的字节，才能实现 parse→serialize 的逐字节保真回环：
 *
 *   1. **有序分隔符位置**：`0xFD`（separator token）在主/全局/EM 变量流、以及
 *      角色块内出现的**全部**位置（契约的 `dimSepIndex` 只能表意单个分界点，
 *      多分隔符场景会丢字节）；
 *   2. **尾部残余字节**：最后一个 EOF 之后未被任何区域消费的正文尾巴
 *      （`remaining` 计过数但从不回写）；
 *   3. **保留头部字节 [12..16]**：16 字节明文头的引擎保留字段（旧实现假设恒 0
 *      并在重组时清零，非 0 保留字节的档因此无法逐字节还原）。
 *
 * 通道形态：`WeakMap`，键 = `parseArchive` 返回的那个 `SnapshotArchive` 对象。
 * 注入链路（`engine.inject`）把同一对象依次喂给 `serializePayload` 与
 * `assembleArchiveFile`，故旁路对消费者不可见（不进入 JSON 结构对比、不污染
 * 契约字段、金样本语义恒等测试零改动）。手工构造的 archive（无旁路）走
 * `dimSepIndex`/无尾字节/保留字段清零的既有回退语义，旧行为逐字节不变。
 */

/** 一个变量流的有序分隔符插入位置（下标 i = "在第 i 个变量之前写一个 0xFD"；
 *  允许 i === vars.length 表示"在全部变量之后、EOF 之前"）。 */
export type SepPositions = readonly number[];

/** 解析产物携带的保真元数据（仅内存旁路，绝不落盘）。 */
export interface ArchiveFidelity {
  /** 16 字节明文头保留字段 [12..16] 的原始字节（4 字节，独立拷贝） */
  readonly reservedHeader: Uint8Array;
  /** 最后一个 EOF 之后未被消费的正文尾字节（独立拷贝；可能为空） */
  readonly trailingBytes: Uint8Array;
  /** 主变量区（normal/var）分隔符位置 */
  readonly varSeps: SepPositions;
  /** 全局变量区（global）分隔符位置 */
  readonly globalVarSeps: SepPositions;
  /** EM 扩展区分隔符位置 */
  readonly emVarSeps: SepPositions;
  /** 各角色块（按 block.index）分隔符位置 */
  readonly charSeps: ReadonlyMap<number, SepPositions>;
}

const store = new WeakMap<object, ArchiveFidelity>();

/** 记录某个解析产物的保真元数据（parse 侧调用）。 */
export function recordFidelity(archive: object, fidelity: ArchiveFidelity): void {
  store.set(archive, fidelity);
}

/** 取回某个解析产物的保真元数据（serialize / assemble 侧调用；无则 undefined）。 */
export function getFidelity(archive: object): ArchiveFidelity | undefined {
  return store.get(archive);
}
