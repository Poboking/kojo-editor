import { basename } from '@kojo/plugin-api';
import type { FileIO, PluginContext } from '@kojo/plugin-api';

/**
 * 通用「从文件夹导入口上项目…」命令的**单一真源**（命令面板入口）。
 *
 * 为什么收敛到共享层：这条命令**游戏无关**——它只做一件事（弹系统目录对话框 → 发
 * 既有的 `workspace.importRequested` 意图），导入流程由各 adapter 自己的向导承接。
 * 过去两个 adapter 各自向 `editor.command` 注册**同一个 id**，同宿主并装时后者抛
 * `already has a contribution` 冲突（红错 + 中断该 adapter 后续注册）。把注册动作收
 * 到此处一次成型，adapter 不再各写一份：谁先激活谁落子，后者见重复即让位，命令面板
 * 里恒为一条。
 *
 * 命令 `run` 发出的 `workspace.importRequested` 是**全局内核事件**（各 adapter 都订了
 * 自家的 `ctx.bus.on('workspace.importRequested')` 去开自己的导入向导），故落子的
 * adapter 用谁的 `ctx`/`io` 都无所谓——两条通道的对话框与意图发射逐字一致。
 */

/** 通用导入命令 id（历史沿用 `kojo.importKojoProject`，不改名——宿主/测试/面板按此引用）。 */
export const IMPORT_KOJO_PROJECT_COMMAND_ID = 'kojo.importKojoProject';
/** 命令面板里那条通用导入命令的标题（单一真源，adapter 不再各抄一份字面量）。 */
export const IMPORT_KOJO_PROJECT_COMMAND_TITLE = '从文件夹导入口上项目…';

/**
 * 系统目录对话框选定 → 发既有的导入意图（命令面板与「我的口上项目」面板按钮走**同一条
 * 通道**，两处行为逐字一致，只差 `source` 标记；KM-13：市场来源据此读上一级 pack.json 兜底署名）。
 *
 * 对话框通道即 `io.chooseWorkspaceRoot`（对话框即授权，铁律 6 的法定形态）——这里只借它的
 * "选目录"形态，授权登记由平台命令内部完成，本函数不碰授权本身。
 */
export async function pickAndRequestImport(
  ctx: PluginContext,
  io: FileIO,
  source: string,
): Promise<void> {
  let picked: string | null;
  try {
    picked = await io.chooseWorkspaceRoot({ title: '选择要导入的作者包文件夹' });
  } catch (err) {
    // 对话框本身起不来（如无对话框能力的环境）：人话出声，不吞——
    // 宁可让作者知道"这条路今天走不通"，也不让他对着毫无反应的按钮发呆。
    const reason = err instanceof Error ? err.message : String(err);
    ctx.log.error(`「从文件夹导入口上项目」打不开目录选择对话框：${reason}`);
    return;
  }
  if (picked === null) {
    // 取消 = 用户自己的动作，安静返回是尊重，不是静默失败。
    return;
  }
  // 末段名做预填建议；根目录（`/`、`C:\`）没有末段 → 不带这个键，
  // 让导入向导按自己的回退链取名，绝不让空串混进事件载荷。
  const suggestedName = basename(picked);
  ctx.bus.emit('workspace.importRequested', {
    sourceDir: picked,
    ...(suggestedName.length > 0 ? { suggestedName } : {}),
    source,
  });
}

/**
 * 判定注册抛错是否为"同一条通用命令已由别处注册"的重复冲突（据 kernel `slots.ts`
 * 的固定措辞）。只有这一种才允许让位——其它任何异常（校验失败等）必须原样上抛，
 * 不让"收敛"变成吞错的口子（铁律 4）。
 */
function isDuplicateImportCommand(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('already has a contribution') &&
    message.includes(`'${IMPORT_KOJO_PROJECT_COMMAND_ID}'`)
  );
}

/**
 * 向 `editor.command` 注册那条通用导入命令。
 *
 * 同宿主并装多 adapter 时，第一条注册成功、其余命中重复 id ⇒ 让位（不报错、不重复
 * 注册），命令面板里恒为一条；单 adapter（或各自独立注册表的测试）时恒落子。
 */
export function registerImportCommand(ctx: PluginContext, io: FileIO): void {
  try {
    ctx.slots.register('editor.command', {
      id: IMPORT_KOJO_PROJECT_COMMAND_ID,
      title: IMPORT_KOJO_PROJECT_COMMAND_TITLE,
      category: '文件',
      // 不写 when：命令不依赖活动文件也不依赖打开的项目，任何上下文都可用
      // （宿主对缺省 when 按"恒可用"求值）——按下去必须听到响，绝不灰着不说话。
      run: () => pickAndRequestImport(ctx, io, 'command-palette'),
    });
  } catch (err) {
    // 只有"这条通用命令已在同宿主注册过"才是预期内的让位；别的错误一律照抛。
    if (!isDuplicateImportCommand(err)) throw err;
  }
}
