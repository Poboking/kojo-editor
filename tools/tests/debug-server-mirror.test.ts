/**
 * 调试宿镜像 × 桌面壳命令面的**防漂移闸**（1029 调试批）。
 *
 * 为什么要有这道闸：
 * `tools/debug-server.mjs` 是 `packages/app/src-tauri/src/lib.rs` 里
 * `generate_handler![...]` 的**手写 Node 镜像**——浏览器调试模式（`?kojo-debug=1`）全部
 * `invoke()` 都打到它身上。手写镜像的失效方式是**静默**的：Rust 侧加了一条命令、镜像没跟上，
 * 页面侧不会得到「镜像落后了」这种可诊断的错，只会拿到一句
 * `调试宿没有实现命令：xxx` 的业务错误，于是「web 模式下这个功能坏了」被当成产品 bug 排查
 * （同 PITFALLS 275 / 277：两处实现靠人肉同步，必然分叉且分叉点没人看得见）。
 *
 * 所以这里把两边命令集当契约对账：
 * 1. Rust 有、镜像没有 ⇒ 必须逐条登记进 `MIRROR_GAPS`（每条写清为什么 web 模式给不出）。
 *    未登记的缺口一律红，并把命令名直接点出来；
 * 2. 镜像有、Rust 完全没有的「幽灵命令」⇒ 必须登记进 `MIRROR_GHOSTS`。幽灵命令更阴——
 *    页面永远不会调用它，它只是让镜像看起来比真实命令面更完整，掩盖真正的缺口；
 * 3. allowlist 自身也要保鲜：登记了但镜像已经实现（或 Rust 已删除）的条目算腐烂，同样红。
 *
 * 比对基准是**运行时真实的命令表**（`DEBUG_HOST_COMMANDS`，`createDebugServer` 构造完就地登记），
 * 不是源码文本——正则扒字面量会被嵌套对象 / 注释 / 引号骗过，而这张表就是 `POST /invoke` 真正查表的那一张。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDebugServer, DEBUG_HOST_COMMANDS } from '../debug-server.mjs';

const LIB_RS_URL = new URL('../../packages/app/src-tauri/src/lib.rs', import.meta.url);

/**
 * Rust 有、镜像没有的命令 —— **每条都必须写原因**，且只能是「web 模式在原理上给不出」的那类。
 * 允许存在的意义：挡住「这一波不修但也不许无声消失」的缺口；不允许拿来当"懒得补"的挡箭牌。
 *
 * 用 Record 而不是 Set：原因和条目写在一起，删条目时原因一起走，不留孤儿注释。
 */
const MIRROR_GAPS: Record<string, string> = {
  // ---- 旧 base64 读通道：web 模式没有调用方 ----
  read_file_bytes:
    '返回 base64 字符串的旧读通道；页面侧已全走 read_file_bytes_raw 的二进制帧（省 1.34× 膨胀），' +
    'Rust 侧只剩 smoke 探针拿它当"两条通道逐字节对照"的参照物。镜像只实现 raw 一支。' +
    '参数形状：{ path } → base64 string。',

  // ---- 启动器（游戏进程 + 实例落盘）：整块是桌面壳独占能力 ----
  launcher_pick_source_root:
    '弹系统目录对话框选游戏源根：依赖 Tauri 原生对话框 + HostState 的根布局登记；' +
    'web 模式没有原生目录选择器（同 choose_directory / choose_file 一类）。参数：{ title? }。',
  launcher_pick_write_root:
    '为某实例挑"写入根"：需要 HostState 的实例根布局与 root_id 校验，纯桌面壳落盘语义。' +
    '参数：{ instance_id, root_id }。',
  launcher_instance_list:
    '实例清单来自 HostState 持有的 launcher 根目录扫描（真实盘上布局）；' +
    'web 模式没有那套根目录与实例元数据，镜像无从枚举。参数：无。',
  launcher_instance_get:
    '按 id 读实例元数据（同上：需要真实 launcher 根布局）。参数：{ instance_id }。',
  launcher_instance_create:
    '建实例要落盘 layout（ensure_root / 目录骨架 / 元数据写入）且 profile 由 TS 侧编译后传入；' +
    'web 模式没有 launcher 根，创建出来的实例无处安放。参数：{ request, profile }。',
  launcher_instance_update:
    '改实例元数据（补丁合并 + 落盘），前提同 create。参数：{ instance_id, patch }。',
  launcher_instance_remove:
    '删实例（含 delete_files / keep_backups 两个破坏性开关）——web 模式连实例都没有，谈不上删。' +
    '参数：{ instance_id, delete_files, keep_backups? }。',
  launcher_instance_duplicate:
    '复制实例目录树（copy 隔离）需要真实根布局。参数：{ instance_id, name? }。',
  launcher_instance_open_folder:
    '在系统文件管理器里打开实例子目录（which 选 open_folder 目标），是 OS 外壳能力，' +
    'web 模式无对应实现。参数：{ instance_id, which }。',
  launcher_trust_executable:
    '把实例的可执行文件登记进信任表（安全面），只有桌面壳持这份信任库。参数：{ instance_id }。',

  // ---- 进程控制：Job 对象 / 收尸 / 挂起创建，Node 镜像不具备 ----
  launcher_start:
    '拉起游戏进程（挂起创建 + Job 对象收尸 + 日志泵），是 Windows 进程层能力；' +
    'web 模式是浏览器 + Node 调试宿，没有可被收尸的子进程树。参数：{ instance_id }。',
  launcher_stop:
    '停实例进程（force / timeout_ms 走 Job 终止语义），依赖 start 建出来的进程。' +
    '参数：{ instance_id, force?, timeout_ms? }。',
  launcher_process_status:
    '查实例进程状态（进程句柄 + Job 记账），无进程则无状态。参数：{ instance_id }。',
  launcher_process_list:
    '列出全部实例进程（HostState 的进程表），web 模式没有这张表。参数：无。',

  // ---- 日志泵产物 ----
  launcher_log_tail:
    '读实例日志泵写出的日志文件（含 LogQuery 游标/过滤），文件由 Rust 侧进程泵产生，' +
    'web 模式既无泵也无产物。参数：{ instance_id, query? }。',
  launcher_log_sessions:
    '枚举某实例的历史日志会话目录。参数：{ instance_id }。',
  launcher_log_read:
    '按 session_id 读日志页（游标 + 过滤）。参数：{ session_id, query? }。',
  launcher_log_export:
    '把日志会话连同诊断打包导出（可选 include_diagnostics），需要日志泵产物 + 诊断落盘。' +
    '参数：{ instance_id, session_id?, include_diagnostics? }。',

  // ---- 归档 / 内容包 ----
  launcher_pick_archive:
    '弹系统文件对话框选归档包（只有 { title? }，没有实例态）——与 choose_file 同属原生对话框，' +
    'web 模式无对应实现。参数：{ title? }。',
  launcher_content_list:
    '列实例已装内容包（读实例根下的内容清单）。参数：{ instance_id }。',
  launcher_content_plan:
    '解归档并出安装计划：要过 Rust 侧的归档解压闸 + 暂存盘，安全执法在桌面壳，镜像不复制这套。' +
    '参数：{ instance_id, archive_path, opts? }。',
  launcher_content_apply:
    '按 plan_id 落盘安装（带冲突决议 resolutions）；plan 本身由 Rust 侧产生。' +
    '参数：{ plan_id, resolutions? }。',
  launcher_content_uninstall:
    '卸载内容包（按 files 回滚落盘）。参数：{ instance_id, pack_id, files? }。',
  launcher_content_set_enabled:
    '开关内容包（改实例清单并落盘）。参数：{ instance_id, pack_id, enabled }。',
  launcher_content_set_order:
    '重排内容包加载顺序（写回清单）。参数：{ instance_id, pack_ids }。',
  launcher_content_diagnose:
    '内容包冲突诊断（读实例清单 + 文件归属判定）。参数：{ instance_id }。',

  // ---- 存档备份 / 导入导出 ----
  launcher_save_list:
    '列实例存档文件（扫实例存档目录）。参数：{ instance_id }。',
  launcher_save_backups:
    '列存档备份清单（扫备份目录）。参数：{ instance_id }。',
  launcher_save_backup:
    '建存档备份（拷贝 + 元数据落盘）。参数：{ instance_id, req }。',
  launcher_save_restore:
    '从 backup_id 还原存档（含 RestoreOptions 决议）。参数：{ instance_id, backup_id, opts? }。',
  launcher_save_delete_backup:
    '删备份目录（破坏性，需真实备份盘）。参数：{ instance_id, backup_id }。',
  launcher_save_import:
    '从归档导入存档（解压闸 + 暂存盘，安全执法在 Rust 侧）。参数：{ instance_id, archive_path }。',
  launcher_save_apply_import:
    '按 plan_id 落盘导入结果（带 SaveResolution 决议）。参数：{ plan_id, resolutions? }。',
  launcher_save_export:
    '把存档打包导出（写归档 + 清单）。参数：{ instance_id, req }。',

  // ---- 长任务簿记 ----
  launcher_task_list:
    '列在跑的长任务（Rust 侧任务表；任务由 plan/backup 等命令派生）。参数：无。',
  launcher_task_cancel:
    '取消某长任务（按 task_id 收回任务句柄）。参数：{ task_id }。',
};

/**
 * 镜像有、Rust 完全不存在的「幽灵命令」——目前为空，留表是为了有登记处而不是就地开洞。
 * 出现幽灵时要么是 Rust 侧删了命令忘了删镜像，要么是镜像自己造了一条没人调用的实现。
 */
const MIRROR_GHOSTS: Record<string, string> = {};

/**
 * 从 `lib.rs` 的 `.invoke_handler(tauri::generate_handler![ ... ])` 里抠出命令名。
 *
 * 边界形态与处理口径：
 * - **模块前缀**：条目可以是 `read_file_bytes` 也可以是 `launcher::commands::launcher_start`，
 *   Rust 注册的是函数，前端 `invoke` 用的是**函数名**，所以按 `::` 取末段；
 * - **注释**：宏体内允许 `//` 行注释与块注释（将来给条目加注释是常事），扫描时跳过，
 *   不参与切分——否则注释里的逗号会把后一条命令切碎；
 * - **嵌套括号**：不用 `\[([\s\S]*?)\]` 这种非贪婪正则（遇到条目里的 `Vec<T>` / 属性宏就提前收口），
 *   而是从锚点开始做方括号配平扫描，`[` +1 / `]` -1，配平到 0 才收；
 * - **尾逗号**：`split(',')` 后必然有空段，直接丢弃；
 * - **形状不认识就炸**：切出来的段必须是一条合法 Rust 路径（末段是标识符）。若出现
 *   `#[cfg(...)]` 之类的属性或宏参数，宁可让闸报错也不静默少条命令——静默正是这道闸要防的。
 */
function parseRustHandlerNames(libRs: string): string[] {
  const anchor = '.invoke_handler(tauri::generate_handler![';
  const at = libRs.indexOf(anchor);
  if (at < 0) {
    throw new Error(
      'lib.rs 里找不到 `.invoke_handler(tauri::generate_handler![`——锚点写法变了，' +
        '请同步更新 tools/tests/debug-server-mirror.test.ts 的解析锚点',
    );
  }

  let i = at + anchor.length;
  let depth = 1; // 已站在 `[` 之后
  let body = '';
  while (i < libRs.length && depth > 0) {
    const c = libRs[i];
    // 行注释：跳到行尾
    if (c === '/' && libRs[i + 1] === '/') {
      while (i < libRs.length && libRs[i] !== '\n') i++;
      body += '\n';
      continue;
    }
    // 块注释：跳到 */
    if (c === '/' && libRs[i + 1] === '*') {
      i += 2;
      while (i < libRs.length && !(libRs[i] === '*' && libRs[i + 1] === '/')) i++;
      i += 2;
      body += ' ';
      continue;
    }
    // 字符串字面量：entry 里不该有，但配平扫描不能因为里面出现 `]` 就错位
    if (c === '"') {
      i++;
      while (i < libRs.length && libRs[i] !== '"') {
        if (libRs[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
    body += c;
    i++;
  }
  if (depth !== 0) throw new Error('lib.rs 的 generate_handler![ 方括号没有配平（宏体被截断？）');

  const names: string[] = [];
  for (const rawEntry of body.split(',')) {
    const entry = rawEntry.trim();
    if (entry === '') continue; // 尾逗号 / 空行
    const last = entry.split('::').pop()!.replace(/\s+/g, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) {
      throw new Error(
        `generate_handler![...] 里出现识别不了的条目：${JSON.stringify(entry)}——` +
          '解析器不认识这种形状，请先补解析规则再加命令（静默跳过等于闸失效）',
      );
    }
    names.push(last);
  }
  return names;
}

const tmpRoot = path.join(os.tmpdir(), `kojo-mirror-gate-${process.pid}`);
let server: Awaited<ReturnType<typeof createDebugServer>> | null = null;

let rustNames: string[] = [];
let mirrorNames: string[] = [];

beforeAll(async () => {
  const libRs = await fs.readFile(LIB_RS_URL, 'utf-8');
  rustNames = [...new Set(parseRustHandlerNames(libRs))];

  // 镜像这一侧要用**真实例**：`DEBUG_HOST_COMMANDS` 在 createDebugServer 构造命令表时登记，
  // 这张表就是 POST /invoke 查表命中的那一张（比正则扒源码字面量更硬）。
  server = await createDebugServer({
    port: 0,
    sandbox: path.join(tmpRoot, 'sandbox'),
    appdata: path.join(tmpRoot, 'appdata'),
  });
  mirrorNames = Object.keys(DEBUG_HOST_COMMANDS).sort();
});

afterAll(async () => {
  await server?.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('调试宿镜像 × generate_handler! 防漂移', () => {
  it('两侧命令表都解析到了东西（解析器空转时不许当通过）', () => {
    expect(rustNames.length).toBeGreaterThan(0);
    // 读空前先怀疑实例没起来，而不是「镜像没有命令」——这是这张表唯一的失败模式
    expect(
      mirrorNames.length,
      'DEBUG_HOST_COMMANDS 是空的：createDebugServer 没跑起来，或命令表登记被删了',
    ).toBeGreaterThan(0);
  });

  it('Rust 有而镜像没有的命令，必须全在 allowlist 里', () => {
    const mirrored = new Set(mirrorNames);
    const gaps = rustNames.filter((n) => !mirrored.has(n));
    const unregistered = gaps.filter((n) => !(n in MIRROR_GAPS));
    expect(
      unregistered,
      `镜像缺了 ${unregistered.length} 条未登记的命令（要么补镜像，要么在 MIRROR_GAPS 里写清为什么 web 模式给不出）：\n` +
        unregistered.map((n) => `  - ${n}`).join('\n'),
    ).toEqual([]);
  });

  it('镜像里不该有 Rust 完全不存在的幽灵命令', () => {
    const rust = new Set(rustNames);
    const ghosts = mirrorNames.filter((n) => !rust.has(n));
    const unregistered = ghosts.filter((n) => !(n in MIRROR_GHOSTS));
    expect(
      unregistered,
      `镜像里有 ${unregistered.length} 条 Rust 侧根本不存在的命令（幽灵命令会掩盖真实缺口）：\n` +
        unregistered.map((n) => `  - ${n}`).join('\n'),
    ).toEqual([]);
  });

  it('allowlist 每一条都写了原因，且没有腐烂条目', () => {
    const mirrored = new Set(mirrorNames);
    const rust = new Set(rustNames);
    for (const [name, reason] of Object.entries(MIRROR_GAPS)) {
      // 原因必须是一句能读懂的话，不接受 '' / 'TODO' / 'x' 这种占位
      expect(reason.trim().length, `MIRROR_GAPS["${name}"] 缺原因`).toBeGreaterThan(12);
      // 已经补上了就该把条目删掉，否则 allowlist 变成"永久豁免"，闸会越来越松
      expect(
        mirrored.has(name),
        `MIRROR_GAPS["${name}"] 已腐烂：镜像现在已经实现它了，请从 allowlist 删掉`,
      ).toBe(false);
      expect(rust.has(name), `MIRROR_GAPS["${name}"] 已腐烂：Rust 侧已没有这条命令`).toBe(true);
    }
    for (const [name, reason] of Object.entries(MIRROR_GHOSTS)) {
      expect(reason.trim().length, `MIRROR_GHOSTS["${name}"] 缺原因`).toBeGreaterThan(12);
      expect(mirrored.has(name), `MIRROR_GHOSTS["${name}"] 已腐烂：镜像里没有这条命令`).toBe(true);
    }
  });

  it('计数：rust / mirrored / allowlisted', () => {
    const mirrored = new Set(mirrorNames);
    const rust = new Set(rustNames);
    const gaps = rustNames.filter((n) => !mirrored.has(n));
    const allowlisted = Object.keys(MIRROR_GAPS).filter((n) => !mirrored.has(n));

    // 三类计数直接打出来：缺口数量是这一波的体检指标，红了要能一眼看到差多少，
    // 不许等到断言失败再去翻 allowlist 数条目。
    console.log(
      `[镜像闸] rust=${rust.size} mirrored=${mirrored.size} allowlisted=${allowlisted.length}` +
        `（缺口 ${gaps.length} / 其中未登记 ${gaps.filter((n) => !(n in MIRROR_GAPS)).length}）`,
    );

    // 恒等式：Rust 的每一条，要么镜像有，要么在 allowlist 里——两边不能有第三者
    expect(mirrored.size + allowlisted.length).toBe(rust.size);
  });
});
