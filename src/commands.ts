import type { SlashCommand } from "./types";

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  "/add-dir": "将目录加入当前会话的可访问范围",
  "/agents": "查看和管理后台 agent",
  "/bug": "报告 Claude Code 问题",
  "/clear": "清空当前对话并开始新的会话",
  "/compact": "压缩当前对话上下文，保留关键内容",
  "/config": "查看或修改 Claude Code 配置",
  "/context": "查看当前上下文使用量",
  "/cost": "查看当前会话的费用与用量",
  "/doctor": "检查 Claude Code 安装和配置",
  "/edit": "允许 Claude 编辑文件",
  "/export": "导出当前对话",
  "/help": "查看可用命令和帮助",
  "/hooks": "查看当前会话的 hooks",
  "/ide": "连接或管理 IDE 集成",
  "/init": "初始化项目的 CLAUDE.md",
  "/mcp": "查看和管理 MCP 服务器",
  "/memory": "查看和管理项目记忆",
  "/model": "选择当前对话使用的模型",
  "/new": "在当前项目中新建对话",
  "/permissions": "查看和配置权限规则",
  "/plan": "切换到计划模式",
  "/plugin": "查看和管理 Claude Code 插件",
  "/project": "新建项目",
  "/rename": "重命名当前会话",
  "/rewind": "回退到之前的对话节点",
  "/status": "查看当前会话状态",
  "/tasks": "查看后台任务",
  "/theme": "选择界面主题",
  "/todos": "查看当前待办事项",
  "/vim": "切换 Vim 输入模式",
};

export const LOCAL_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/model", description: BUILTIN_DESCRIPTIONS["/model"] },
  { name: "/new", description: BUILTIN_DESCRIPTIONS["/new"] },
  { name: "/project", description: BUILTIN_DESCRIPTIONS["/project"] },
  { name: "/clear", description: BUILTIN_DESCRIPTIONS["/clear"] },
  { name: "/compact", description: BUILTIN_DESCRIPTIONS["/compact"] },
  { name: "/context", description: BUILTIN_DESCRIPTIONS["/context"] },
  { name: "/plan", description: BUILTIN_DESCRIPTIONS["/plan"] },
  { name: "/edit", description: BUILTIN_DESCRIPTIONS["/edit"] },
];

export function describeSlashCommand(name: string) {
  const normalized = `/${name.replace(/^\//, "")}`.toLowerCase();
  return BUILTIN_DESCRIPTIONS[normalized] ?? "自定义 Claude 命令";
}

export function normalizeSlashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = typeof raw === "string"
      ? { name: raw, description: undefined }
      : raw && typeof raw === "object"
        ? raw as Record<string, unknown>
        : null;
    if (!item || typeof item.name !== "string") continue;
    const name = `/${item.name.replace(/^\//, "")}`;
    if (!name.slice(1) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const description = typeof item.description === "string" && item.description.trim()
      ? item.description.trim()
      : describeSlashCommand(name);
    commands.push({ name, description });
  }
  return commands;
}

