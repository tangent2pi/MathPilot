import { chmod, chown, lchown, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const AGENTS_MD = `# MathPilot 教师备课与题库工作区

你是 MathPilot 教师备课与内容制作 Agent。帮助教师抽取资料、制作题库和讲解数学。此处不是学生测评，不加载学生学习上下文或操作学生画像。资料导入使用 ktq-extraction，错因研究使用 er-research；按实际结果汇报进度，不把接单说成完成。

## 文件边界

- 数学公式用标准 LaTeX：行内用 $...$，独立公式用 $$...$$；不要把数学公式放在 Markdown 代码围栏中。代码围栏只用于真正的程序代码。
- respond 是结果注册工具，不是结束对话。注册成功后继续用简体中文总结真实成果和去重情况，提示教师在会话审核卡确认；禁止自动批准、重复注册或自行启动下一阶段。

- 当前目录是本线程唯一可写工作区。
- input/ 是教师资料、题目与冻结快照的只读输入；output/ 和 tmp/ 可写。
- .agent/ 是宿主维护的审计与发布区，禁止读取后伪造状态或直接写入。
- 教师上传内容位于 input/original/，先列目录，再按需使用 read 或相应 Skill。
- 当前线程标识写在 input/session/thread.json；产物 manifest 的 session_id 必须使用其中的 thread_id。
- {{SKILLS_ROOT}} 是只读 Skill 根；需要能力时先读取对应 SKILL.md。
- 不修改长期画像，不伪造判定、审计记录或其他线程数据。
`;

const DIRS = [
  "task/runs", "input/question", "input/student", "input/session", "input/original",
  "output/artifacts", "output/drafts", "tmp", ".agent",
];

async function repairRetiredLauncherOwnership(root: string, uid: number, gid: number): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await repairRetiredLauncherOwnership(target, uid, gid);
    else await lchown(target, uid, gid);
  }
  await chown(root, uid, gid);
}

export async function assemblePiChatWorkspace(root: string, skillsRoot: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  for (const dir of DIRS) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), AGENTS_MD.replaceAll("{{SKILLS_ROOT}}", skillsRoot), "utf8");
  // Repair ownership left by the retired setpriv launchers. The official
  // runtime now launches as the service identity and performs its own user
  // namespace/capability drop before the model command starts.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const uid = process.getuid();
    const gid = process.getgid?.() ?? 0;
    await repairRetiredLauncherOwnership(root, uid, gid);
    await chmod(root, 0o500);
    for (const relative of ["output", "tmp"]) {
      const directory = path.join(root, relative);
      await chmod(directory, 0o700);
    }
  }
}

export async function bindPiThreadWorkspace(root: string, threadId: string): Promise<void> {
  await writeFile(
    path.join(root, "input", "session", "thread.json"),
    JSON.stringify({ schema: "mathpilot.pi-thread/v1", thread_id: threadId }, null, 2),
    "utf8",
  );
}
