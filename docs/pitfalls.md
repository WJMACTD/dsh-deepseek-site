# 本机环境坑速查

> 都是在这台机器上真踩过、修过的。每条给「症状 → 判断 → 处理」。
> 只在 **Windows 沙箱 + 这个 DSH profile** 下成立，换机器请先重测再照抄。

## 1. 写文件报 EPERM，但 `icacls` 看着有写权限

**症状**：`write`/`node` 写 `publish/index.json`、`locale/zh.json` 失败，
`EPERM: operation not permitted, open 'D:\Project\AI Project\dsh-deepseek-site\publish\index.json'`。

**判断**：`icacls publish` 里的 ACE 是**上一会话**的沙箱 SID（形如 `S-1-4-912580147-1068391292:(I)(OI)(CI)(W,D,DC)`），
当前会话是另一串 `S-1-4-…`。继承看起来是 `(W,D,DC)`，但 SID 不匹配，内核照样拒绝。

**处理**：用 `diagnose-windows-sandbox-acl` 技能的 bundled 脚本，对**单个路径**跑一次未受限版本（需要 danger-full-access 审批），
它会备份 DACL、授予当前账户 FullControl、并给出 `status=verified`。`publish/`、`locale/` 都这么修过。
同一台机器上如果只有 `pwsh` 被拒、`write`/`edit` 工具能写，直接改用工具写，不必再修 ACL。

## 2. `%TEMP%` 不可写

**症状**：`[sandbox: file access denied under workspace-write mode]`，脚本往 `C:\Users\…\AppData\Local\Temp` 落文件失败。

**处理**：临时脚本/产物一律放工作区 `.dsh-tmp\`（已在 `.gitignore`）。

## 3. `npm pack` / `npm install` 报 EPERM

**症状**：默认缓存在不可写盘（这台机器是 `E:\nodejs`）。

**处理**：`npm pack --pack-destination .dsh-tmp --cache .dsh-tmp/npm-cache`。

## 4. 所有 HTTPS 都失败（schannel）

**症状**：`Invoke-WebRequest`、`curl.exe`、`git` 报
`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`。

**判断**：不是没网，是 Windows schannel 拿不到凭证。

**处理**：
- 查网页用 `node` 的 `fetch`（OpenSSL）或 `web_fetch` 工具。
- `git` 加 `-c http.sslBackend=openssl`。
- `git push` 最终可用姿势：
  ```powershell
  $env:GIT_TERMINAL_PROMPT='0'; $t=(gh auth token)
  git -c http.sslBackend=openssl push "https://x-access-token:$t@github.com/WJMACTD/dsh-deepseek-site.git" main
  ```
  会在 stderr 打一行 `sh.exe: couldn't create signal pipe, Win32 error 5`，**忽略即可**，push 仍成功。

## 5. `http.extraHeader` 认证时好时坏

**症状**：早期 `-c http.extraHeader="AUTHORIZATION: basic <b64>"` 能用，后来 `Recv failure: Connection was reset`。

**处理**：改用 `x-access-token@` 拼进 URL 的形式（见上）。credential helper 路线的失败是 `failed to execute prompt script (exit code 66)`——它依赖 `sh`，别走。

## 6. `github.com:443` 间歇性连不上

**症状**：`Failed to connect to github.com port 443 after 21037 ms`、`Connection was reset`；
但 `gh api`（`api.github.com`）和 `cdn.jsdelivr.net` 都正常。

**判断**：探一下就知道：
```powershell
Test-NetConnection -ComputerName github.com -Port 443 -InformationLevel Quiet
```
`False` 就是线路问题，不是凭证问题。

**处理**：等十几秒重试（本次最多重试 4 次成功）；不要因此去换 token 或改远程地址。

## 7. jsDelivr 一直在发旧索引

**症状**：新版本已推、release 已发，`cdn.jsdelivr.net/.../publish/index.json` 返回的
`plugins[0].versions[0].version` 还是上一版（`@main` 有 `s-maxage=43200`）。

**处理**：
```powershell
node -e "fetch('https://purge.jsdelivr.net/gh/WJMACTD/dsh-deepseek-site@main/publish/index.json').then(r=>r.text()).then(console.log)"
```
返回 `{"status":"finished",…}` 后**必须再取一次**索引核对版本号——本次就是 purge 前拿到 1.5.0、purge 后才是 1.6.1。
也顺带 purge 钉住 commit 的 URL（`@<sha>`），否则部分边缘节点仍命中旧对象。

## 8. 插件安装失败：pnpm 正常结束、界面像装上了

**症状**（用户侧只看到这些）：
`Packages: +1 -13`、`[WARN] Moving dsh-deepseek-site_tmp_28060_4 to "node_modules\.ignored\…"`、`Progress: resolved 283, reused 1, downloaded 1, added 0`。

**判断**：
- `%USERPROFILE%\.dsh\profiles\desktop\.plugin-manager\logs\github-connection-*\git.log` 才有真因
  （`dsh: connection to github.com timed out after 5000ms`，前置探测默认 5 s 超时）。
- profile 的 `package.json` 里 `dsh.profile.bundles` 与 `dependencies` 会被**整体回滚**，
  但运行期注册还在 → 界面看着正常，重启后入口消失。判断以 `profile/package.json` +
  `node_modules/dsh-deepseek-site/package.json` 的版本为准。

**处理**：修掉 TLS 或 junction（见 §4、§9）后重装，并确认返回 `application: "applied"`。

## 9. 旧 dev junction 导致 `ERR_PNPM_EPERM`

**症状**：`[ERR_PNPM_EPERM] [importPackage …\node_modules\dsh-deepseek-site] EPERM: operation not permitted, rename '…dsh-deepseek-site_tmp_28588_11' -> '…dsh-deepseek-site'`。

**判断**：`node_modules\dsh-deepseek-site` 不是真目录，而是指向工作区的 Junction（`git`/`pnpm` 都没法原子替换它）。

**处理**（只删链接，不动源目录）：
```powershell
cmd /c rmdir "C:\Users\15139\.dsh\profiles\desktop\node_modules\dsh-deepseek-site"
```

## 10. 工作区 `.git` 被失败的安装弄坏

**症状**：`fatal: not a git repository`；目录里只剩 `objects/` 与 `refs/`，`HEAD`、`config`、`index`、`hooks` 全没了，`.dsh-tmp` 也被删。

**处理**（历史在 `refs/heads/main` 里，能就地恢复）：
```powershell
git init
git symbolic-ref HEAD refs/heads/main
git config user.name KLY; git config user.email kly@users.noreply.github.com
git remote add origin https://github.com/WJMACTD/dsh-deepseek-site.git
git reset --mixed            # 让索引对齐 HEAD，工作区文件不动
git branch --set-upstream-to=origin/main main
```

## 11. 想在应用里「自动点一下」——做不到

**症状**：`SetCursorPos` / `PostMessage` 返回 `False`；`SendInput` 返回 3（被接受）但光标不动、应用无反应；
UIA `AutomationElement.FromHandle(...)` 只得到 `ControlType.Pane | Chrome Legacy Window`，`FindAll(Button)` 为 0。

**判断**：DSH 沙箱禁止输入注入；Chromium 不向 UIA 暴露树。

**处理**：交互验证请用户点一次；其余用截图 + `cordis_inspect_query` 的 Slots 树证明注册状态。
截图脚本：`powershell -ExecutionPolicy Bypass -File "C:\Users\15139\.trae-cn\skills\screenshot\scripts\take_screenshot.ps1" -Mode temp [-WindowHandle <h>] [-Region x,y,w,h]`。
注意 **`-Region` 用物理像素，全屏图是逻辑像素**（2560×1600 物理 / 2048×1280 逻辑，DPI 1.25）。

## 12. 读 `app.asar` 解析失败

**症状**：`SyntaxError: Unexpected token '<', "<sH 7sH {"…`。

**判断**：`E:\DeepSeek Harness\resources\app.asar` 的头部是 Chrome pickle，**JSON 从第 16 字节开始**（不是常见的 8）；
数据基址 = `16 + headerEnd`，按 4 字节对齐。

**处理**：按上面偏移重写 reader；或直接 `grep` asar 原始字节找锚点。常用路径见 [../AGENTS.md](../AGENTS.md) §6。

## 13. 其它小坑

| 症状 | 处理 |
| --- | --- |
| 后台 `pwsh` 任务里带中文 → `ParserError: 变量引用无效` | 后台命令只用 ASCII 输出，中文放到前台或写文件 |
| `cordis_inspect_query` `Slots.listSubTree` 一次几万 token | 非必要不查；要查就查最小 root，并先压缩已消费的历史 |
| `gh release view --json isLatest` → `Unknown JSON field` | 用 `gh api repos/<o>/<r>/releases --jq '.[0].tag_name'` 判断 Latest |
| `web_fetch` 访问 `raw.githubusercontent.com` 30 s 超时 | 本机直连不稳；用 jsDelivr 或 `gh api .../contents` 读文件 |
