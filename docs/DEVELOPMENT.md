# 代码结构与排查入口

这份说明面向阅读、修改和排查 PCL Linux 代码的开发者，描述当前实现。复杂事务的状态与约束放在对应 Rust 模块的开头，修改实现时应同步更新。

## 从哪里开始读

| 职责 | 入口 | 主要内容 |
| --- | --- | --- |
| 前端状态与桌面调用 | `apps/desktop/src/main.tsx` | 页面、当前目录、bootstrap、作用域 API 与响应接纳 |
| 实例管理界面 | `InstancesPanel.tsx`、`InstanceOperations.tsx` | 实例资料、改名确认、组件修改与导出 |
| 下载与任务界面 | `DownloadPanel.tsx`、`TaskManager.tsx` | 任务轮询、完成刷新、取消后返回 |
| 桌面命令与应用生命周期 | `apps/desktop/src-tauri/src/main.rs` | 命令参数、目标绑定、任务调度、游戏进程与关闭处理 |
| 改名编排 | `instance_rename_service.rs` | 组合文件/资料 revision、进度、错误归类与缓存刷新 |
| 持久设置与实例资料 | `config.rs`、`instance_meta.rs`、`export_presets.rs` | 多目录、选择与内存、元资料、导出配置 |
| 文件操作 | `resource_ops.rs`、`instance_reset.rs`、`instance_export.rs` | 本地资源事务、组件重置、ZIP 导出 |
| 任务协调 | `tasks.rs`、`downloads.rs` | 单写入任务、取消与结束语义、下载页面的任务投影 |
| Minecraft 核心 | `crates/core/src/lib.rs` | 版本识别、继承、依赖、Java 选择和启动参数 |
| 下载与安装 | `crates/install/src/` | 网络请求、校验缓存、原版与加载器安装 |
| 账号 | `crates/auth/src/lib.rs`、桌面的 `accounts.rs` | 认证协议、密钥环、账号状态与刷新 |

表中未写目录的 Rust 文件位于 `apps/desktop/src-tauri/src/`；TSX 文件位于 `apps/desktop/src/`。现有桌面和前端 `main` 仍承担较多协调工作；新增业务应先确定职责归属，避免继续堆入页面或命令函数。

## 以实例改名为例

阅读顺序：

1. `InstancesPanel.tsx` 的检查与确认：客户端提交名称和确认 revision。
2. 桌面 `main.rs` 的 `instance_rename_prepare`、`instance_rename_start`：解析已登记目录、检查游戏/任务占用，重新准备并核对 revision，再捕获目标并启动工作线程。
3. `instance_rename_service::prepare` 和 `CheckedRename`：把物理文件计划、启动器引用和组合 revision 明确放在一起。引用载荷保留在 Rust 内部。
4. `instance_rename::execute`：验证快照、暂存 JSON、持久登记、移动核心与目录、提交文件状态。完整恢复状态表在该模块开头。
5. `instance_rename_refs::apply`：按固定目标更新设置、元资料、导出配置和撤销记录。每个目标接受预期的修改前或修改后状态，以便重启后继续完成部分迁移。
6. 服务刷新内存中的设置/元资料，命令记录最终任务结果，前端重新读取 bootstrap。

`instance_rename.rs` 管理游戏文件与事务阶段；`instance_rename_refs.rs` 管理启动器资料和项目级待恢复标记；`instance_rename_service.rs` 把两者接到应用任务与缓存。前端导航可以变化，已提交任务始终使用捕获的目标目录。

### 排查改名与恢复问题

- **检查或确认被拒绝**：先看服务的组合 revision，再分别检查文件计划与引用快照；不要通过移除校验来绕过目标变化。
- **取消被接受但结果异常**：查看任务的 `begin_finishing` 和事务的 `committing` 回调。关闭取消接纳后必须再读一次已接受的 token，第一处文件移动后按事务失败/恢复处理。
- **目录已是新名，但恢复要回旧名**：以持久 journal 状态为准。目录移动与 `FilesCommitted` 的持久登记之间存在崩溃窗口。
- **文件改名完成、资料只改了一部分**：查看 `FilesCommitted` 的引用重放。此时应继续完成引用；回滚文件会让已经迁移的引用指向不存在的名字。
- **资料保存或恢复报外部修改**：检查目录身份、文件快照和待恢复标记。保留冲突文件与备份；不直接删除标记或放宽哈希/身份比较。
- **界面重新出现旧选择或内存设置**：检查 config 的 transport revision、`save_settings` 返回值及前端响应接纳条件。保存成功后的新 revision 必须被采用；旧响应不能覆盖已经更新的 bootstrap。
- **切到另一个目录后恢复按钮不可用**：检查 bootstrap 中待恢复的根目录匹配。登记路径可以是别名，事务绑定的是规范路径和目录身份。

## 修改时维持的约束

- **明确目标和所有权**：命令捕获 `root_id`、规范目录和实例 ID；后台任务不随当前页面重新选择目标。删除或清理只处理已登记且仍匹配的文件。
- **文件操作与资料同步分清提交边界**：改变 journal 状态顺序、fsync、原子发布或 marker 清理顺序时，必须重新检查各崩溃窗口的恢复行为。反例用例放在改名模块的 `tests.rs` 中。
- **注释说明原因**：记录不可破坏的约束、锁顺序、失败/恢复策略以及不明显的平台限制。普通语句用清楚的命名表达；过长流程先按职责提取函数。
- **避免含糊的组合值**：有关联的计划、引用和 revision 使用具名结构；错误和副作用应在调用处可见。
- **变更说明和回归用例一起维护**：深层 bug 的用例应覆盖导致故障的时序或数据状态；仅复述实现步骤的测试不能证明恢复正确。

## 验证入口

```sh
# 完整 Rust 工作区，包含桌面命令与应用集成。
cargo test --workspace --locked --features pcl-desktop/custom-protocol

# 改名文件事务及引用迁移的定向用例。
cargo test --locked -p pcl-desktop --features custom-protocol instance_rename

# 类型检查与前端生产构建。
npm run build --prefix apps/desktop

# 格式检查。
cargo fmt --all -- --check
```

改名文件事务用例在 `apps/desktop/src-tauri/src/instance_rename/tests.rs`，引用迁移用例在 `instance_rename_refs/tests.rs`，应用集成用例在桌面 `main.rs`。它们使用独立样例目录；不要把个人实例路径或账号数据写入公开测试。

Rust 测试不能证明真实桌面选择器、网络授权页面或 Minecraft 启动正常。涉及这些边界时，还需要按[使用指南](USAGE.md)在专用实例中手动验证。
