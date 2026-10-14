/**
 * eraTW 口上包「日文名 → 中文名」对照词典（展示用；只住 adapter）。
 * 用途：导入 / 浏览日文命名的既有包时，把日文名以「日文（中文）」形式展示
 *（如 追加ファイル（附加文件））。**只加显示备注，不改任何实际目录/文件名**。
 * 键为**日文片段**（名字含该片段即命中，最长优先命中；名字自身已含对应中文时不重复）。
 */
export const ERATW_NAME_GLOSSARY: Readonly<Record<string, string>> = Object.freeze({
  追加ファイル: '附加文件',
  面ファイル: '面文件',
  ライセンス: '授权信息',
  テンプレート: '模板',
  資源: '资源',
  画像: '图像',
  セーブ: '存档',
  設定: '设置',
  サンプル: '示例',
});

/** 词典键按**长度降序**（同长保序）——最长片段优先命中，避免「ライセンステンプレ」只命中短键。 */
const GLOSSARY_KEYS: readonly string[] = Object.keys(ERATW_NAME_GLOSSARY).sort(
  (a, b) => b.length - a.length,
);

/**
 * 给日文名加「（中文）」对照后缀（纯函数）。
 * - 取**最长**命中的日文键（避免「ライセンステンプレ」只命中短键）；
 * - 命中中文片段已在 name 里 → 原样返回（不重复添加）；
 * - 无命中 → 原样返回（fail-visible，绝不猜）。
 */
export function glossName(name: string): string {
  if (!name) return name;
  for (const key of GLOSSARY_KEYS) {
    if (name.includes(key)) {
      const zh = ERATW_NAME_GLOSSARY[key]!;
      if (name.includes(zh)) return name;
      return `${name}（${zh}）`;
    }
  }
  return name;
}
