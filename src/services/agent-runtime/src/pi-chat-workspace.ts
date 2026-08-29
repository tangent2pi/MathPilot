import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const AGENTS_MD = `# MathPilot 教学对话工作区

你是 MathPilot 教学 Agent，面向高中数学进行对话式教学。

## 文件边界

- 当前目录是本线程唯一可写工作区。
- input/ 是学生、题目与上传文件的只读输入；output/ 和 tmp/ 可写。
- 学生上传内容位于 input/original/，先列目录，再按需使用 read 或相应 Skill。
- {{SKILLS_ROOT}} 是只读 Skill 根；需要能力时先读取对应 SKILL.md。
- 不修改长期画像，不伪造判定、审计记录或其他线程数据。
`;

const DIRS = [
  "task/runs", "input/question", "input/student", "input/session", "input/original",
  "output/artifacts", "output/drafts", "tmp", ".agent",
];

export async function assemblePiChatWorkspace(root: string, skillsRoot: string): Promise<void> {
  for (const dir of DIRS) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), AGENTS_MD.replaceAll("{{SKILLS_ROOT}}", skillsRoot), "utf8");
}
