/**
 * 插件项目模板（`PluginTemplateId` → 骨架文件）。
 *
 * ## 为什么模板住本包，而不是每个 adapter 各写一份
 *
 * 契约 `GamePluginRules.scaffold` 是 **adapter 的供数通道**（adapter 想给什么就给什么）；
 * 但「新项目至少得有一个能构建的空骨架」这件事与游戏无关：清单由 core 生成、路径守卫在 core、
 * 回滚在 core，模板若也只住 adapter，那所有 adapter 激活前就一个项目都建不出来。
 * 因此本文件提供**游戏无关的最小骨架**（模板 id 是契约里的通用枚举），adapter 的
 * `scaffold` 一旦提供就整块顶替它（不是叠加：两套生成器叠着写会出双真源）。
 *
 * ## 三条纪律
 *
 * 1. **只返回内容，不写盘**：落点与回滚全部在 `plugin-project.ts`（写授权不外泄）；
 * 2. **不碰游戏目录**：模板是纯字符串，不读不搬任何游戏文件（版权素材不外流）；
 * 3. **零游戏知识**：文件名与正文都不提具体游戏 / 具体脚本语法（审计 D 项），
 *    扩展名与注释风格取中性形态——真正的内容由作者在编辑器里写。
 */

import type { PluginScaffoldOptions, PluginScaffoldResult } from '@kojo/plugin-api';

/**
 * 模板产物 + 一个便利位：`entry` = 生成结果里最适合当加载入口的文件
 * （相对制品根；`null` = 没有可当入口的文本文件，此时 `entrypoints` 留空）。
 */
export interface BuiltinTemplateResult extends PluginScaffoldResult {
  readonly entry: string | null;
}

/** 与 adapter 的 `scaffold` 同形的内容分组（`files` / `binaryFiles` / `report`） */
function readme(options: PluginScaffoldOptions, rootFrom: string, lines: readonly string[]): string {
  return [
    `# ${options.displayName}`,
    '',
    `- 插件 id：\`${options.pluginId}\``,
    `- 目标游戏 id：\`${options.gameId}\``,
    `- 面向模板：\`${options.template}\``,
    `- 声明能力：${options.capabilities.length === 0 ? '（无）' : options.capabilities.join('、')}`,
    `- 目标游戏版本：${options.gameVersion ?? '未指定（实例尚未提供版本）'}`,
    `- 源文件根：\`${rootFrom}/\``,
    '',
    '## 这个骨架怎么用',
    '',
    '1. 在编辑器的项目树里直接改源文件；',
    '2. `plugin.json` 是**唯一真源**：哪些目录进包由它的 `roots[]` 决定；',
    '3. 构建产物只写 `build/`（已在 `.gitignore` 里排除），源与产物分离；',
    '4. 构建时会逐文件算摘要并做确定性打包，作者不需要手写任何哈希。',
    '',
    ...lines,
    '',
  ].join('\n');
}

const CAPABILITY_NOTES: Readonly<Record<string, string>> = {
  'add-content': '只追加文件，不改既有文件——升级时旧文件留不留由作者自己负责。',
  'override-functions': '覆盖 / 替换既有函数：冲突会在安装预览里逐条列出，需要用户确认。',
  'add-commands': '注册新命令 / 新入口：入口文件在 `plugin.json` 的 `entrypoints` 里声明。',
  'modify-data': '修改数据表：数据文件按字节打包，编码由作者保持原样。',
  'replace-resources': '替换图片 / 音频等资源：二进制按字节打包，不做转码。',
};

/**
 * 生成内置骨架。`rootFrom` = 向导第一条根映射的源目录（模板文件放在它下面，
 * 这样「新建即能构建」——文件不落在任何映射里等于没生成）。
 */
export function builtinTemplate(
  options: PluginScaffoldOptions,
  rootFrom: string,
): BuiltinTemplateResult {
  const prefix = rootFrom.length === 0 ? '' : `${rootFrom.replace(/\/+$/, '')}/`;
  const note = CAPABILITY_NOTES[options.template] ?? '最小骨架：只有一个说明文件。';
  const report = [
    `模板 ${options.template}：生成 ${prefix}README.md` +
      (options.template === 'blank' ? '' : ` 与 ${prefix}main.txt`),
    note,
  ];

  if (options.template === 'blank') {
    const readmePath = `${prefix}README.md`;
    return {
      entry: null,
      report,
      files: {
        [readmePath]: readme(options, rootFrom, [
          '## 空白模板',
          '',
          '这个模板只放一个说明文件：把要分发的文件放进上面的「源文件根」，',
          '并确认它们都在 `plugin.json` 的 `roots[]` 映射范围内。',
        ]),
      },
    };
  }

  const header = [
    `工程：${options.displayName}（${options.pluginId}）`,
    `目标游戏：${options.gameId}`,
    `能力：${options.capabilities.join(', ') || '(none)'}`,
    '',
  ].join('\n');

  const body =
    options.template === 'data-patch'
      ? `${header}这里放数据表补丁内容；表结构与编码由目标游戏决定，本工具原样打包。\n`
      : options.template === 'add-commands'
        ? `${header}这里放新命令 / 新入口的实现；入口文件记得写进 plugin.json 的 entrypoints。\n`
        : options.template === 'override-functions'
          ? `${header}这里放要覆盖的函数实现；与既有函数的冲突会在安装预览里逐条列出。\n`
          : `${header}这里放要追加的内容；本模板只生成示例，不读取游戏目录里的任何文件。\n`;

  const mainRel =
    options.template === 'data-patch' ? `${prefix}data/patch.txt` : `${prefix}main.txt`;

  const files: Record<string, string> = {
    [mainRel]: body,
    [`${prefix}README.md`]: readme(options, rootFrom, ['## 模板说明', '', note]),
  };
  const binaryFiles: Record<string, Uint8Array> = {};
  if (options.template === 'resource-pack') {
    // 四字节占位：只为让「二进制资源走 io.writeBytes 逐文件补写」这条链路有东西可写，
    // 内容无意义（作者会整体替换掉）。
    binaryFiles[`${prefix}assets/placeholder.bin`] = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  }

  return {
    entry: mainRel,
    files,
    ...(Object.keys(binaryFiles).length === 0 ? {} : { binaryFiles }),
    report,
  };
}
