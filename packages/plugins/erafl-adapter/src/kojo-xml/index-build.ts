/**
 * 全项目口上 XML 索引。
 *
 * 只做聚合，不读盘：输入是各文件的 `KojoXmlFile`，输出是面板 / 诊断 / 预览共用的
 * 一份索引。排序与去重都**确定**——同一批文件不论枚举顺序如何，产出的索引逐字段
 * 相等（`scannedAt` 除外）。这条不是洁癖：索引会进派生缓存判据，顺序敏感就等于
 * 每次重开都"变了一次"。
 */
import type { KojoXmlDiagnostic, KojoXmlFile, KojoXmlIndex } from '@kojo/plugin-api';

/** 诊断排序：path → 行 → 列 → 码（稳定，跨平台一致） */
function compareDiagnostics(a: KojoXmlDiagnostic, b: KojoXmlDiagnostic): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.span.start.line !== b.span.start.line) return a.span.start.line - b.span.start.line;
  if (a.span.start.column !== b.span.start.column) return a.span.start.column - b.span.start.column;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

/**
 * 建索引。
 *
 * `byCom` 的键：`com` 属性原样（大小写**不归一**——`ANY` 与 `any` 在引擎里是不是同一
 * 条命令属游戏知识，adapter 没说之前宿主不替它猜）；缺席记在空串键下，面板据此
 * 单独显示"没有 com 的条目"。
 */
export function buildKojoXmlIndex(
  files: readonly KojoXmlFile[],
  now: number = Date.now(),
): KojoXmlIndex {
  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const byChara = new Map<number, KojoXmlFile[]>();
  const byCom = new Map<string, number>();
  const diagnostics: KojoXmlDiagnostic[] = [];
  let commandCount = 0;

  for (const file of sortedFiles) {
    if (file.charaNo !== null) {
      const bucket = byChara.get(file.charaNo);
      if (bucket) bucket.push(file);
      else byChara.set(file.charaNo, [file]);
    }
    for (const command of file.commands) {
      commandCount++;
      const key = command.attrs['com'] ?? '';
      byCom.set(key, (byCom.get(key) ?? 0) + 1);
    }
    for (const diagnostic of file.diagnostics) diagnostics.push(diagnostic);
  }

  // 角色号升序（Map 的插入序不可依赖：文件按路径排序，角色号不随之单调）
  const orderedByChara = new Map<number, readonly KojoXmlFile[]>(
    [...byChara.entries()].sort((a, b) => a[0] - b[0]),
  );

  return {
    files: sortedFiles,
    commandCount,
    byChara: orderedByChara,
    byCom,
    diagnostics: diagnostics.sort(compareDiagnostics),
    scannedAt: now,
  };
}
