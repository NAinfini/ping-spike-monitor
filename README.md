# Ping Spike Monitor

<p align="center">
  <img src="./resources/app-logo.png" width="96" alt="Ping Spike Monitor 路径与延迟尖峰标志" />
</p>

Windows 桌面网络诊断工具。它持续采集默认网关和公网基准点的延迟、丢包与抖动，把相关异常聚合为事件，并在 Electron 仪表盘中展示实时与历史趋势。

完整的产品范围、架构取舍和验收标准见 [PLAN.md](./PLAN.md)。

## 开发

项目只使用 pnpm，版本由 `packageManager` 字段固定。

```powershell
pnpm install
pnpm dev
```

关闭窗口后应用留在系统托盘并继续采集。Windows 休眠期间无法采集；恢复后采集器会重新启动。

## 验证与构建

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

`pnpm test:e2e` 会构建并短暂启动隔离数据目录中的 Electron 应用，检查侧栏固定、实时图表、最小窗口布局、弹窗、主题与三语切换。

生成 Windows 安装包：

```powershell
pnpm package
```

开发构建输出到 `out/`，安装包输出到 `release/`。运行数据写入 `%LOCALAPPDATA%\PingSpikeMonitor\monitor.sqlite`，不会放进仓库或依赖网络连接。

## 当前首版边界

- 默认网关自动发现。
- 公网基准点使用 Cloudflare `1.1.1.1` 与 Google `8.8.8.8`。
- ICMP 采样通过参数数组调用 Windows `ping.exe`，不经过 shell。
- SQLite 是唯一事实来源；Renderer 仅通过白名单 IPC 读取数据。
- 区域固定节点、DNS/HTTPS 探测、测速与导出按 `PLAN.md` 的后续阶段接入。
