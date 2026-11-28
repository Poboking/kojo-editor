/**
 * MCP 错误码 / 剔除原因的人类可读文案（**唯一真源**，屏面只读这张表）。
 *
 * 背景：机器码（`E_TOOL_NOT_APPROVED` 这类）散在 Rust 宿主与 TS 侧，屏上原样显示
 * 等于让用户读日志。本表只负责「说人话 + 给出路」：
 *   · `human` —— 屏上那一句（一行能读完，不重复机器码）；
 *   · `hint`  —— 下一步怎么办，进 `title` 悬浮（屏宽有限，不抢列宽）。
 *
 * 纪律：
 *   · 不写 token / 端口 / 绝对路径 / 具体游戏名——文案是通用面，不是某台机器的日志；
 *   · `human` 非空、无 TODO、不含自身机器码（机器码留在 `title` 里给排障的人）；
 *   · 覆盖闸见 `packages/app/tests/mcp-audit-panel-groups.test.ts` A5：源码里每一枚
 *     完整 `E_*` 码都必须是 `MCP_ERROR_COPY` 的键，新码上线不补文案就红。
 *
 * 本表**只作用于视觉行**：`formatAuditEntry` 的文本导出输出逐字不变。
 */

export interface McpCodeCopy {
  /** 屏上一句话：发生了什么。 */
  human: string;
  /** 下一步怎么办（悬浮提示，可选）。 */
  hint?: string;
}

/** 键＝`E_*` 机器码。 */
export const MCP_ERROR_COPY: Record<string, McpCodeCopy> = {
  /* ---------------------------- 协议 / 传输层 ---------------------------- */
  E_PARSE: {
    human: '请求不是合法的 JSON，宿主没能解析',
    hint: '检查客户端发出的报文是否被截断或拼错，然后重发',
  },
  E_INVALID_REQUEST: {
    human: '请求结构不合法，缺少或写错了必要字段',
    hint: '对照 MCP 协议检查 method、jsonrpc 等字段的写法',
  },
  E_METHOD_NOT_FOUND: {
    human: '宿主没有这个方法',
    hint: '确认客户端调用的是已支持的方法名，必要时重新拉一次能力清单',
  },
  E_INVALID_PARAMS: {
    human: '参数不符合这个工具的要求',
    hint: '对照该工具的输入说明检查参数名、类型与必填项',
  },
  E_UNAUTHORIZED: {
    human: '本次连接没有通过身份校验',
    hint: '重新启动 MCP 服务，用新签发的连接信息再连',
  },
  E_FORBIDDEN_ORIGIN: {
    human: '来源不被允许访问本地服务',
    hint: '从宿主允许的来源发起连接，不要用第三方页面直连',
  },
  E_RATE_LIMITED: {
    human: '调用太频繁，触发了每分钟配额',
    hint: '降低调用频率，稍后重试',
  },
  E_TIMEOUT: {
    human: '调用超过时限被中止',
    hint: '缩小单次请求的数据量，或拆成多次再试',
  },
  E_CANCELLED: {
    human: '调用被取消',
    hint: '确认客户端没有主动中断；还需要结果就重新发起',
  },
  E_RESPONSE_TOO_LARGE: {
    human: '返回内容超过大小上限',
    hint: '缩小范围（更少的行、更小的文件）后重试',
  },
  E_CALL_BUDGET_EXCEEDED: {
    human: '同时在跑的调用太多，暂时排不上',
    hint: '等前一批调用结束后再发，或减少批量并发',
  },
  E_BRIDGE_UNAVAILABLE: {
    human: '宿主内部通道暂时不可用',
    hint: '稍后重试；持续出现就重启 MCP 服务',
  },
  E_INTERNAL: {
    human: '宿主内部出错',
    hint: '重试一次；仍然失败请带上发生时间反馈',
  },
  E_UNSUPPORTED_PROTOCOL_VERSION: {
    human: '客户端声明的协议版本宿主不支持',
    hint: '升级客户端，或改用宿主支持的协议版本',
  },

  /* ------------------------------- 路径 / 权限 ------------------------------- */
  E_PATH_ESCAPE: {
    human: '路径越出了允许的根目录',
    hint: '改用项目根内的相对路径',
  },
  E_PATH_TARGET_FORBIDDEN: {
    human: '目标位置被规则禁止写入',
    hint: '换到项目内的普通目录，不要指向受保护位置',
  },
  E_PATH_SCHEME: {
    human: '路径形态不被接受',
    hint: '用项目内相对路径，不要带协议头或绝对路径',
  },
  E_TOOL_FAIL_CLOSED: {
    human: '这个工具默认关闭，只有显式放开才可用',
    hint: '在设置里确认该工具属于开放面；联网类工具始终关闭',
  },
  E_TOOL_NOT_APPROVED: {
    human: '这个工具需要你在设置里逐项批准后才能用',
    hint: '设置 › AI 接入 › 批准面，勾选该工具名（通配符不算）',
  },
  E_TIER_DENIED: {
    human: '当前会话的权限档位不够调用这个工具',
    hint: '提高会话档位，或在批准面为该工具单独放行',
  },

  /* ------------------------------ 编辑器：写入 ------------------------------ */
  E_EDITOR_APPLY_FAILED: {
    human: '编辑没能写进文档',
    hint: '确认文档仍处于打开状态，然后重试',
  },
  E_EDITOR_APPLY_UNVERIFIED: {
    human: '写完后回读内容没变，按失败处理',
    hint: '检查文档是否只读或被立刻还原，再重试',
  },
  E_EDITOR_DERIVED_VIEW: {
    human: '目标是派生视图，改写它不会改到源文件',
    hint: '改源文件本身，不要改预览或派生视图',
  },
  E_EDITOR_READ_ONLY: {
    human: '这个文档是只读的，不能改',
    hint: '先解除只读，或换一个可写文档',
  },
  E_EDITOR_UNSUPPORTED: {
    human: '这个操作在当前编辑器类型上不支持',
    hint: '换用支持该操作的编辑器，或改用文本编辑',
  },
  E_EDITOR_PANE_GONE: {
    human: '目标编辑器已经关闭',
    hint: '重新打开该文档后重试',
  },
  E_EDITOR_INVALID_ARGS: {
    human: '编辑参数不完整或不合法',
    hint: '补上必填的定位与文本参数',
  },

  /* ------------------------------ 编辑器：打开 ------------------------------ */
  E_EDITOR_GUI_NOT_MOUNTED: {
    human: '编辑器界面还没挂载，没法执行',
    hint: '先打开一个编辑器再重试',
  },
  E_EDITOR_OPEN_CHANNEL_MISSING: {
    human: '打开文档的通道没接上',
    hint: '重启应用后再试',
  },
  E_EDITOR_OPEN_HOST_MISSING: {
    human: '宿主侧没有可用的打开接口',
    hint: '确认应用安装完整，重启后再试',
  },
  E_EDITOR_OPEN_UNVERIFIED: {
    human: '文档打开了，但没能确认状态',
    hint: '手动确认文档是否已打开，再重试',
  },

  /* -------------------------------- 快速修复 -------------------------------- */
  E_QUICKFIX_UNLISTED: {
    human: '这条修复动作不在当前清单里',
    hint: '先列一次问题清单，再执行清单里给出的动作',
  },
  E_QUICKFIX_CROSS_SESSION: {
    human: '这条修复动作属于另一个会话',
    hint: '在本会话重新列清单后再执行',
  },
  E_QUICKFIX_POSITION_MISMATCH: {
    human: '执行位置和列清单时的位置对不上',
    hint: '用清单里给出的位置执行，或重新列清单',
  },
  E_QUICKFIX_STALE: {
    human: '修复动作放太久，已经过期',
    hint: '重新列清单，取新的动作',
  },
  E_QUICKFIX_ACTION_EXPIRED: {
    human: '这条修复动作已经失效',
    hint: '重新列一次问题清单，用新的动作',
  },
  E_QUICKFIX_DOC_CHANGED: {
    human: '文档在列清单之后改过，旧动作已过期',
    hint: '重新列清单，拿新的动作再执行',
  },
  E_QUICKFIX_PANE_GONE: {
    human: '动作所属的编辑器已经不在了',
    hint: '重新打开文档并重新列清单',
  },
  E_QUICKFIX_DERIVED_VIEW: {
    human: '修复落在派生视图上，改了也不算数',
    hint: '在源文件上重新发起修复',
  },
  E_QUICKFIX_RUN_INTENT: {
    human: '这条动作要跑命令，当前没有开放该通道',
    hint: '手动执行，或改选带就地修改的修复',
  },
  E_QUICKFIX_EDIT_SHAPE: {
    human: '修复携带的编辑内容格式不对',
    hint: '重新列清单取标准动作，不要手改动作内容',
  },
  E_QUICKFIX_APPLY_FAILED: {
    human: '修复没能应用到文档',
    hint: '确认文档仍打开且可写，然后重试',
  },
};

/**
 * 键＝审计 `note` 的剔除原因码（Rust `FilterReason::as_str`，只有三枚）。
 * 三者必须一眼可分：档位不够 / 没逐项批准 / 联网类永远关闭。
 */
export const MCP_REASON_COPY: Record<string, McpCodeCopy> = {
  tier_filtered: {
    human: '本会话档位不够，工具被过滤掉',
    hint: '提高会话档位，或在批准面单独放行该工具',
  },
  privileged_not_approved: {
    human: '特权工具还没逐项批准',
    hint: '设置 › AI 接入 › 批准面，按工具名逐个勾选',
  },
  market_fail_closed: {
    human: '联网类工具始终关闭，不是你没批准',
    hint: '这类工具不开放，换用本地能力',
  },
};

/** 已知错误码取文案；未知码返回 `undefined`（屏面回退到原文，不吞）。 */
export function copyForError(code: string): McpCodeCopy | undefined {
  return MCP_ERROR_COPY[code];
}

/** 已知剔除原因取文案；未知原因码返回 `undefined`（屏面回退到原文，不吞）。 */
export function copyForReason(reason: string): McpCodeCopy | undefined {
  return MCP_REASON_COPY[reason];
}
