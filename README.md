# dsh-deepseek-site

在 Harness 左侧图标栏加一个入口，点开后在**应用窗口内部的中央面板**里直接显示 <https://chat.deepseek.com/>，不跳系统浏览器，并跨重启保留登录。

## 功能

- 左侧图标栏出现「官网」入口（外链箭头图标，`order: 3`）。
- 点击后在中央面板内嵌官网，面板自带工具栏：重新加载、在系统浏览器打开（兜底）。
- 同一个 `WORKSPACE_KEY` 复用同一个 guest 分区，面板来回切换不丢登录态。
- 应用重启后自动回填上次的登录快照，免重复登录。
- 工具栏「忘记本机登录」可清除本机保存的凭据。
- 运行环境没有 `window.dshDesktop.browser`（例如普通浏览器里打开 Web UI）时，面板显示说明卡片并给出兜底按钮，不静默跳转。

## 登录记忆

外壳给每个 workspace 分配的分区是**进程内生命周期**的（`dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀），所以 guest 自己的 localStorage 在应用重启后就空了。插件用「快照 + 回放」绕开：

1. guest 在站点文档上每次 `did-finish-load`、站内路由变化、以及每 15 秒（且仅在窗口可见时）执行 `CAPTURE_SCRIPT`，只读 `userToken` / `__appKit_userInfo` 两个键；
2. 有 token 就写进**应用文档自己的 localStorage**（`deepseek-site:sign-in:v1`）。应用文档是 `dsh-app://app/`（`registerSchemesAsPrivileged` 里 `standard: true`），默认 session 持久化，所以快照能跨重启保留；
3. 下次打开面板，`did-finish-load` 时先 `executeJavaScript(restoreScript(...))` 把快照写回 guest 的 localStorage，写过就 `reload()` 一次，站点启动时直接看到有效 token；
4. guest 里已有有效 token（同一次运行内切面板）则**不覆盖**，避免把新登录态写回旧值。

工具栏的「已记住登录」胶囊表示快照已保存；旁边的状态文字说明最近一次打开走了哪条路：

| 状态 | 含义 |
| --- | --- |
| 已回填登录 | 快照写进内嵌页并重新加载了一次 |
| 登录有效 | 内嵌页本来就有 token，没有覆盖 |
| 无登录快照 | 本机还没记录过登录，或回填被拒 |

### 忘记本机登录

工具栏上的「忘记本机登录」（只有存在快照时才出现）会同时删掉应用文档里的快照和 guest 里的两份凭据，然后重载内嵌页，站点回到登录页。如果只删应用文档，下一次捕获会把仍然登录的 guest 里的 token 又写回去，所以两边都要清。

### 诊断记录

面板每次在站点文档上完成加载时，会在应用文档的 `localStorage` 写一条 `deepseek-site:diag:v1`（环形缓冲，最近 20 条，且只在结论/次数/token 长度变化时才追加）。每条只有四个字段：`at`（时间）、`note`（本次回填结论）、`attempts`（回填尝试次数）、`tokenLen`（快照里有效 token 的字符数）。这条记录**不含** token、响应体、cookie 名和完整 URL。

## 隐私与凭据

- 快照是明文 JSON，存在本机应用数据目录里（Harness 桌面版的 Electron 用户数据目录，其下 `Local Storage/leveldb`）。它与 Harness 自身的登录态同等敏感：能读这个目录的人就能拿到你的 DeepSeek 账号凭据。
- 快照只保留两个键：`userToken`（凭据本体）和 `__appKit_userInfo`（站点恢复会话身份用的用户资料）。`__appKit_*` 特性位、`__ds_remote_feature_did` 之类的键刻意不复制——站点自己会重建，复制只会扩大暴露面。
- 快照在应用文档的 localStorage 里，与 Harness Web UI 同源，因此同源的插件代码理论上也能读到。不要装来路不明的插件。
- 不想要了：点「忘记本机登录」，或移除插件后手动清理应用数据目录。
- `WORKSPACE_KEY`（`client.js:19`）刻意是固定值 `dsh-deepseek-site`，不按工作区拆分：外壳按这个键缓存一个 guest 分区，固定值让所有工作区共用同一个内嵌浏览器容器，登录态与站点偏好不会随工作区切换而重来。代价是工作区之间不再隔离浏览容器——对本插件（只开一个固定站点）来说是划算的。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch`、`exports`、`dsh.client` |
| `cordis.patch.yml` | 把 `deepseek-site` 这一行插入 profile |
| `index.js` | 宿主侧 `apply() {}`（空实现，仅为满足 bundle 入口） |
| `client.js` | 客户端模块：注册 `sidebar.panellist` 图标 + `main` 面板，内嵌 webview 逻辑 |
| `locale/zh.json`、`locale/en.json` | 插件市场展示用的 `meta.title` / `meta.description`（界面文案内联在 `client.js`，平台只从 locale JSON 读 `meta`） |
| `icon.svg` | 128×128 原创图标 |
| `test-signin.cjs` | 登录快照逻辑的单元测试 |

## 安装 / 更新

### 从插件市场安装（推荐，给其他人用）

插件已经发布成一个 format-1 市场索引，地址：

```text
https://raw.githubusercontent.com/WJMACTD/dsh-deepseek-site/main/publish/index.json
```

在 DSH 里打开**插件 → 发现 → 添加索引源**，粘贴上面的地址，然后搜索「DeepSeek 官网」安装即可。装完左侧图标栏出现入口，点开在中央面板里加载 `chat.deepseek.com`。

注意：登录快照是**本机行为**——插件把你在内嵌页登录后的凭据快照存在本机应用数据里，跨应用重启回填。它不随插件分发，别人装好后需要自己登录一次，之后重启保持登录。

### 从本机源码安装

在本机源码目录下用插件管理器安装（目录名按你的实际路径替换）：

```text
plugin_manager(action="install_bundle", target="<插件目录的绝对路径>")
```

装好后按 `Ctrl+R` 重新加载窗口即可生效；若图标未出现，重启 Harness 桌面版。

### 自己发布一份索引

见 [`publish/RELEASE.md`](./publish/RELEASE.md)（从提交、推送、生成索引到版本升级的完整清单）。

## 测试

```bash
node --check client.js && node --check index.js
node test-signin.cjs
```

`test-signin.cjs` 从 `client.js` 里切片取出**真实的**声明（不是副本），在伪造的 `localStorage` 上验证：捕获白名单、`tokenValue`、`minimizeSnapshot`（含超长值）、回填四态（空 guest / 已登录 / 登出标记 / 被删 token）、`CLEAR_SCRIPT` 只清两个键、应用侧读写/忘记往返、诊断环形缓冲与字段白名单、`pickUrl` / `isSiteUrl`、`shouldCapture` 的可见性与去重门控。
