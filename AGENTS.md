# 项目说明（给新会话的 agent）

> 这个文件会被 DSH 自动加载进上下文。**先读完再动手**，能省掉一半的现场探查。
> 面向用户的功能说明在 `README.md`，发布清单在 `publish/RELEASE.md`，这里只写「是什么、怎么跑、哪里有坑」。

## 1. 这是什么

一个 DSH 桌面端插件 `dsh-deepseek-site`：在 Harness 左侧图标栏加一个入口，点开在**应用窗口内部的中央面板**里用 Electron `<webview>` 内嵌 `https://chat.deepseek.com/`，不跳系统浏览器，并且**跨应用重启保留登录**（本地快照 + 回填）。

- 版本：`1.6.1`（`package.json`）
- 仓库：`https://github.com/WJMACTD/dsh-deepseek-site`（public，账号 `WJMACTD`）
- 已发布：release `v1.6.1`（Latest），资产名固定为 `dsh-deepseek-site.tgz`（不带版本号，`releases/latest/download/` 永久可用）
- 本机状态：profile `desktop`（`C:\Users\15139\.dsh\profiles\desktop`）依赖 `github:WJMACTD/dsh-deepseek-site#c4dc42f…`，`dsh.profile.bundles` 里有 `dsh-deepseek-site`，已 `applied`
- 目标用户场景：Windows + DSH 桌面版；Web 版没有 `window.dshDesktop.browser`，会显示「不支持」卡片

## 2. 架构要点（改代码前必须知道）

### 2.1 插件形态
- 单包、双半：
  - `index.js` 是 Host 半，`export function apply() {}`，**空实现**（本插件全在客户端跑）。
  - `client.js` 是 Client 半，用 `window.__ModuleLoader__.load({ id: 'dsh-deepseek-site', factory(require) { … } })` 包起来，只能 `require('react')`，拿不到 `window` 之外的 Node 能力。
- `package.json` 的 `dsh` 字段决定加载：`bundle.patch: ./cordis.patch.yml` + `client: { platform: 'web', immediately: true }`；`cordis.patch.yml` 只有一句 `- insert: - id: deepseek-site / name: 'dsh-deepseek-site'`。
- `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`；本机 Harness 是 `0.2.1-rc.3`（打包在 `E:\DeepSeek Harness\resources\app.asar`）。

### 2.2 内嵌机制（不要自己发明）
- 桥：`window.dshDesktop.browser = { acquire(workspace), release(lease), onOpenRequested(lease, listener) }`，只在该应用窗口的主 frame、`dsh-app://app` 源下存在。
- `acquire('dsh-deepseek-site')` → `{ lease, partition }`；随后必须这样建 guest，否则主进程 `will-attach-webview` 会拒绝：
  ```js
  const guest = document.createElement('webview')
  guest.setAttribute('name', lease)
  guest.setAttribute('partition', reservation.partition)
  guest.setAttribute('allowpopups', '')
  guest.setAttribute('src', 'about:blank#' + lease)   // 主进程从 src.slice(12) 解析 lease
  ```
- 主进程会强制 `nodeIntegration:false / contextIsolation:true / sandbox:true / webviewTag:false / disableDialogs:true / httpreferrer:''`，并对每个 session 拒绝全部 permission、下载；`onBeforeRequest` 只放行 http/https/ws/wss/about/data/blob。站外弹窗走 `onOpenRequested` 回调后一律 `deny`。
- `partition` 是**进程内随机**的（按 workspace key 缓存），所以**关掉应用 cookie/Web Storage 就没了** → 才有了快照回填。

### 2.3 页面为什么在 `document.body` 上
- `createBrowser(bridge)`（`client.js:552`）建一个 `position:fixed; display:none` 的容器，里面是唯一的 guest；`attach(anchor)` 把容器按 `anchor.getBoundingClientRect()` 摆到面板位置，200 ms 轮询 + resize/scroll 重摆。
- 好处：切到别的面板再回来**不重载**，正在生成的回答不断。切走时 `detach()` 会先 `capture(true)` 存一次快照。
- 只有一个页面实例，`detach(handle)` 里判断 `current === handle`，避免别的入口把当前页面藏掉。

### 2.4 登录保留（快照 / 回填）
- 抓：`CAPTURE_SCRIPT` 在 guest 里 `executeJavaScript`，只取 `SNAPSHOT_KEYS = ['userToken', '__appKit_userInfo']`，单值上限 64 KiB；15 s 一次 + 页面内跳转时；`shouldCapture()` 做去重。
- 存：写到**应用文档**的 `localStorage`（`deepseek-site:sign-in:v1`），所以跨重启还在（应用源是 standard+secure 协议，localStorage 会持久化）。
- 回填：站点 `did-finish-load` 且 `isSiteUrl(currentUrl())` 时，用 `restoreScript()` 把 token 写回 guest 再 `reload()` 一次，`RESTORE_ATTEMPT_LIMIT = 2`；期间容器上的遮罩（`cover`）遮住登录页闪烁。
- 手动清理：工具栏「忘记本机登录」= `forgetSignIn()`（删应用快照）+ `CLEAR_SCRIPT`（清 guest 凭据）。
- 诊断：`deepseek-site:diag:v1` 环形缓冲 20 条，只有 `at/attempts/tokenLength/...`，**不含 token 本身**。

### 2.5 注册点（三个，别加错）
| 位置 | 代码 | 说明 |
| --- | --- | --- |
| 左栏入口 | `client.js:1151` `ctx.slots.register({ name: 'sidebar.panellist', id: 'deepseek-site', order: 3, label: () => t('nav'), locale: NS }, owner => h(Mark, { size: owner.size, active: owner.active }))` | `order: 3` 落在「插件市场」之后 |
| 中央面板 | `client.js:1164` `ctx.slots.register({ name: 'main', key: 'deepseek-site', locale: NS, inject: () => ({ t }) }, () => h(BrowserView, { t }))` | `main` 同一时刻只渲染一个 key |
| 退出清理 | `client.js:1182` `ctx.inject(['layout'], …)` | 插件卸载时若当前面板是本插件，`layout.selectPanel(null)` |

`conversation.view` 标签在 1.6.1 已删除，**不要再加回来**（用户明确说只要左侧入口）。

### 2.6 布局规则（1.6.1 的教训）
- Windows 上外层 frame 已经 `padding-top: var(--dsh-windows-titlebar-height)` 预留了标题栏；`--dsh-frame-top-clearance` 只在 `html[data-platform=darwin]`（48 px）和 `html[data-windows-titlebar]` 上有意义。**插件页面在 Windows 上不要再叠加 clearance**，否则凭空多约 40 px 空白。
- 现在的写法（`client.js:1042`）：
  ```js
  const PAGE_TOP = typeof document !== 'undefined' && document.documentElement.getAttribute('data-platform') === 'darwin'
    ? 'calc(16px + var(--dsh-frame-top-clearance, 0px))'
    : '16px'
  ```
- **这个判读必须放在 `zh`/`en` 字典之后**：`test-signin.cjs` 切片执行 `client.js` 时没有 `document`，放前面会直接崩。

## 3. 文件地图

| 文件 | 作用 |
| --- | --- |
| `client.js`（44.6 KB，约 1190 行） | 全部功能：常量、纯函数、快照脚本、`createBrowser`、`BrowserView`、注册 |
| `index.js` | Host 半，空 `apply()` |
| `cordis.patch.yml` | 把 `deepseek-site` 插进 profile 的 bundle 列表 |
| `test-signin.cjs`（10.1 KB） | 单测：从 `client.js` 切出 `const SITE_URL` → `const zh = {` 之间，在 `localStorage` stub 下跑 |
| `publish/build-index.mjs` | 生成 format 1 市场索引（内联 icon、钉 commit、`--index-url`），用 `market-index-validator.mjs` 校验 |
| `publish/index.json` | 生成的索引（当前钉在 `c4dc42f`，插件版本 1.6.1） |
| `publish/RELEASE.md` | 发布清单：预检、push、生成索引、收录 awesome、常见安装失败、版本升级 |
| `publish/WJMACTD__dsh-deepseek-site.yml` | awesome-dsh-plugin 的收录条目（category `ui`，icon 用 180px PNG raw，tarball 用 latest 链接） |
| `README.md` | 用户视角：功能、和同类插件对比、安装、隐私与凭据、文件表、更新日志 |
| `docs/architecture.md` | 时序图与状态机：点开入口、切走保活、重启回填、容器结构、7 条不变量 |
| `docs/pitfalls.md` | 本机环境坑速查（13 条，带症状/判断/命令） |

## 4. 开发与验证

```powershell
cd "D:\Project\AI Project\dsh-deepseek-site"
node --check client.js          # 语法
node test-signin.cjs            # 快照/回填/UA/站外链接单测，最后一行是 OK 汇总
node -e "JSON.parse(require('fs').readFileSync('locale/zh.json','utf8'))"   # locale 合法性
```

装到本机（改完要看效果时）：

```
plugin_manager action=install_bundle target="git+https://github.com/WJMACTD/dsh-deepseek-site.git#<sha>"
# 或本地打包后装 tarball（不产生 junction，适合快速试）：
npm pack --pack-destination .dsh-tmp --cache .dsh-tmp/npm-cache
plugin_manager action=install_bundle target="D:\Project\AI Project\dsh-deepseek-site\.dsh-tmp\dsh-deepseek-site-1.6.1.tgz"
```

装完不用重启：`application: applied` 会热重载客户端半。**验证注册**用
`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={root:'sidebar.panellist'})`，
但注意它会返回整棵树（几万 token），非必要别查。

## 5. 发布流程（顺序别改）

1. 改 `package.json` version、（必要时）`publish/build-index.mjs` 里的文案 → `node --check` + `node test-signin.cjs`。
2. 提交 + push（本机必须带 TLS 后端与 token，见 §6）：
   ```powershell
   $env:GIT_TERMINAL_PROMPT='0'; $t=(gh auth token)
   git -c http.sslBackend=openssl push "https://x-access-token:$t@github.com/WJMACTD/dsh-deepseek-site.git" main
   ```
3. 生成索引并**钉到上一个代码 commit**（不要钉索引自身的 commit，否则循环）：
   ```powershell
   node publish/build-index.mjs --git https://github.com/WJMACTD/dsh-deepseek-site `
     --commit <code-sha> `
     --index-url https://cdn.jsdelivr.net/gh/WJMACTD/dsh-deepseek-site@main/publish/index.json `
     --homepage https://github.com/WJMACTD/dsh-deepseek-site `
     --repository https://github.com/WJMACTD/dsh-deepseek-site --author KLY
   ```
   然后单独提交 `publish/index.json`。
4. 打包 + 发 release（资产名保持 `dsh-deepseek-site.tgz`，不带版本）：
   ```powershell
   npm pack --pack-destination .dsh-tmp --cache .dsh-tmp/npm-cache
   Copy-Item .dsh-tmp\dsh-deepseek-site-<ver>.tgz .dsh-tmp\dsh-deepseek-site.tgz -Force
   gh release create v<ver> .dsh-tmp\dsh-deepseek-site.tgz --title "v<ver> …" --notes "…" --latest
   ```
5. **刷 jsDelivr 并复核**（`@main` 有 `s-maxage=43200`，不刷别人装到的还是旧版）：
   ```powershell
   node -e "fetch('https://purge.jsdelivr.net/gh/WJMACTD/dsh-deepseek-site@main/publish/index.json').then(r=>r.text()).then(console.log)"
   ```
   再取一次索引确认 `plugins[0].versions[0].version` 是新版本。

市场安装地址（给对方 / 给自己重装都用这条）：
`https://cdn.jsdelivr.net/gh/WJMACTD/dsh-deepseek-site@main/publish/index.json`
（raw 地址可用但本机直连常超时；GitHub Pages 没开）

## 6. 环境坑（都真实踩过，别重复）

### 沙箱 / 文件
- 目录若只继承**上一会话**的沙箱 SID（`icacls` 里是 `S-1-4-…` 旧值），写入会 `EPERM: operation not permitted`，即使看起来有 `(I)(W,D,DC)`。用 `diagnose-windows-sandbox-acl` 技能里的脚本修，并验证；`publish/`、`locale/` 都修过。
- 同一台机器上 `pwsh` 的 `Set-Content` 可能被拒而 `write`/`edit` 工具能写 → 改文件优先用 `write`/`edit`。
- `%TEMP%` 可能不可写（`[sandbox: file access denied under workspace-write mode]`）→ 临时脚本一律放工作区 `.dsh-tmp\`（已 gitignore）。
- `npm pack` 必须带 `--cache .dsh-tmp/npm-cache`，否则默认缓存在不可写盘上报 `EPERM`。

### 网络 / TLS
- PowerShell `Invoke-WebRequest`、`curl.exe`、`git` 默认都走 Windows schannel，会以 `schannel: SEC_E_NO_CREDENTIALS (0x8009030e)` 失败；HTTPS 校验走 `node` 的 fetch 或 `web_fetch` 工具更稳。
- `git push` 的可用姿势见 §5；`http.extraHeader="AUTHORIZATION: basic …"` 早期能用，后来会 `Recv failure: Connection was reset`，`x-access-token@` 形式更稳。
- `github.com:443` 会**间歇**连不上（`Failed to connect … 21037 ms`、`Connection was reset`），但 `api.github.com`、`cdn.jsdelivr.net` 正常。push 前先 `Test-NetConnection github.com -Port 443`，失败就重试几次，不要误判成凭证问题。
- `raw.githubusercontent.com` 本机常超时（`UND_ERR_CONNECT_TIMEOUT`，`web_fetch` 30 s 超时）→ 索引优先 jsDelivr。
- `gh release view --json isLatest` 这个字段不存在，判断 Latest 用 `gh api repos/<o>/<r>/releases --jq '.[0].tag_name'`。

### 插件安装链
- 旧的 dev junction（`node_modules/dsh-deepseek-site` → 工作区）会让 pnpm 失败：
  `[ERR_PNPM_EPERM] [importPackage …] EPERM: operation not permitted, rename '…_tmp_×××' -> '…'`。
  解掉：`cmd /c rmdir "C:\Users\15139\.dsh\profiles\desktop\node_modules\dsh-deepseek-site"`（只删链接）。
- 安装失败会**回滚 profile**（`dsh.profile.bundles` 与 `dependencies` 里的记录被撤掉，pnpm 打印 `Packages: +1 -13`、包被挪进 `node_modules/.ignored`），但运行期注册还在 → 界面看着正常，重启就没了。判断以 `profile/package.json` + `node_modules/dsh-deepseek-site/package.json` 为准。
- 前置的 `checkGithubConnection` 有 5 s 超时，报错只在 `.plugin-manager/logs/github-connection-*/git.log`（`dsh: connection to github.com timed out after 5000ms`），`pnpm.log` 结尾是正常的 `Progress: resolved …`。
- 失败的安装曾把工作区 `.git` 弄坏（只剩 `objects/`、`refs/`，`HEAD/config/index` 全丢，`.dsh-tmp` 被删）。恢复：`git init` + `git symbolic-ref HEAD refs/heads/main` + `git config user.name/email` + `git remote add origin …` + `git reset --mixed`，再用 `git branch --set-upstream-to=origin/main main`。

### 界面验证
- 沙箱**禁止注入输入**：`SetCursorPos` / `PostMessage` 返回 False，`SendInput` 返回 3 但光标不动、应用无反应。要验证交互只能请用户点一次。
- UIA 对 Chromium 只暴露 `ControlType.Pane | Chrome Legacy Window`，`FindAll(Buttons)` 为 0，元素级调用不可能。
- `cordis_inspect_list/query` 没有 DOM/eval provider（host: Service/Event/Config/Tool；client: Service/Event/Builtin/Slots/Theme），拿不到渲染态。
- 截图脚本：`powershell -ExecutionPolicy Bypass -File "C:\Users\15139\.trae-cn\skills\screenshot\scripts\take_screenshot.ps1" -Mode temp [-WindowHandle <h>] [-Region x,y,w,h]`；**`-Region` 用物理像素，全屏图是逻辑像素**（2560x1600 物理 / 2048x1280 逻辑，DPI 1.25），换算错会裁到别处。
- 后台 pwsh 任务里写中文会被编码破坏（`ParserError: 变量引用无效`）→ 后台命令只用 ASCII 输出。

### Harness 内部（需要读 asar 时）
- `E:\DeepSeek Harness\resources\app.asar` 的头部是 Chrome pickle：**JSON 从第 16 字节开始**（不是常见的 8），数据基址 = `16 + headerEnd`，按 4 字节对齐。用错偏移会得到 `Unexpected token '<', "<sH 7sH {"`。
- 常见路径：`/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js`（安装/回滚逻辑，`installBundle`）、`/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`（frame 与 `--dsh-frame-top-clearance`）、`/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js`（官方 `<webview>` 用法参考）。

## 7. 版本历史

- **1.5.0**：左栏入口 + 中央面板，快照/回填登录；首次发布。
- **1.6.0**：页面常驻 `document.body`（切走不重载）、回填遮罩、站外链接 2 s 去重、UA 只剥 `Electron/<版本>`；一度加了 `conversation.view` 会话标签（1.6.1 已删）。
- **1.6.1**：只保留左侧入口；Windows 顶部留白从「18px + clearance」改为 16px（修掉约 40px 空白），工具栏/卡片统一 20px 边距、工具栏可换行。

## 8. 待办 / 边界

- awesome-dsh-plugin 收录：仓库 `createdAt` 是 2026-10-29T08:53:31Z，**2026-10-30 16:53（+08）之后**才过「仓库满 1 天」的 CI 门槛；条目 `publish/WJMACTD__dsh-deepseek-site.yml` 已按单入口版本写好。PR 上限 3 条、需要 `dsh-plugin` topic（已加）。
- 根目录有个遗留产物 `dsh-deepseek-site-1.5.0.tgz`（`.gitignore` 已忽略 `*.tgz`），可随手删。
- 长期记忆写在 `F:\Tools\dsh-memory`（工作区外，写它需要 danger-full-access 审批；用户对这类提权可能拒绝，别反复试）。
- 边界：登录快照是**明文 JSON 存本机**应用 `localStorage`，只按 workspace key 隔离，不做加密；插件只对 `chat.deepseek.com` 生效，别的站点不通用；Web 版显示「不支持」卡片。
