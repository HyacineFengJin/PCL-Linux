import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const project = resolve(desktop, "../..");
const root =
  process.env.PCL_GAME_ROOT || resolve(project, "Minecraft/.minecraft");
const instances = JSON.parse(
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "pcl-cli",
      "--",
      "--project",
      project,
      "--root",
      root,
      "list",
    ],
    { cwd: project, encoding: "utf8" },
  ),
);
const preview = {
  settings: {
    root,
    player: "Player",
    memory_gib: 6,
    selected:
      instances.find((i) => i.mod_count > 0)?.id || instances[0]?.id || null,
    overrides: {},
  },
  instances,
  status: {
    stage: "idle",
    message: "准备就绪",
    version: null,
    pid: null,
    exit_code: null,
  },
};
mkdirSync(resolve(desktop, "public"), { recursive: true });
writeFileSync(
  resolve(desktop, "public/preview.json"),
  JSON.stringify(preview, null, 2),
);
console.log(
  `已生成 ${instances.length} 个本机版本的界面预览快照（不打包、不提交 Git）。`,
);
