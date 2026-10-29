# 发布清单 · 让别人装上这个插件

把插件发布成一个 **DSH 插件市场索引**（format 1），别人在 DSH 里添加这个索引地址，就能搜到并一键安装。

整个流程只有一件事是必须你自己做的：**把这个仓库推到你的 GitHub**。索引里必须写明源码位置（npm 包或 GitHub 仓库 + 提交 SHA），宿主装的是那处源码，而不是本机目录。

---

## 0. 先确认要发布的内容

```bash
# 在仓库根目录执行
node --check client.js && node --check index.js
node test-signin.cjs          # 应输出 sign-in snapshot logic OK
npm pack --dry-run --cache .dsh-tmp/npm-cache
```

生成索引需要 `publish/` 的依赖（`semver`），全新克隆先装一次：

```bash
cd publish && npm install && cd ..
```

`npm pack --dry-run` 应该只列出 9 个文件（`package.json` / `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/*.json` / `README.md` / `LICENSE`），约 15 kB。`files` 字段会把 `node_modules`、`.dsh-tmp`、`publish` 都排除掉。

## 1. 推到 GitHub

```bash
git add -A
git commit -m "feat: DeepSeek 官网内嵌面板与登录快照"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

仓库根目录就是插件包根目录（`package.json` 在最外层），这样 `source.type: git` 不需要 `path`。

## 2. 生成索引（关键一步）

```bash
node publish/build-index.mjs \
  --git https://github.com/<owner>/<repo> \
  --index-url https://raw.githubusercontent.com/<owner>/<repo>/main/publish/index.json
```

- 省略 `--commit` 时自动取当前 `HEAD`，即上面那次提交；也可以显式传 `--commit <40 位 sha>`（受限 shell 里 git 子进程可能被拦，这时显式传 SHA）。
- 命令会加载**从 DSH 安装包里取出的真实校验器** `parseMarketIndex`，不合法会直接失败，不会写出坏索引。
- 生成的 `publish/index.json` 里 `icon` 是内联的 `data:image/svg+xml;base64,...`（约 1.1 kB），索引是单文件，不需要另一个图标文件。

提交并推送索引：

```bash
git add publish/index.json
git commit -m "chore: 生成市场索引"
git push
```

`index.json` 里记录的 SHA 指向上一次提交，这是正常的：宿主从那个提交取插件源码，而索引本身晚一步进入仓库不会有影响。

## 3. 别人怎么用

在对方的 DSH 里：**插件 → 发现 → 添加索引源**，填：

```text
https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/publish/index.json
```

国内网络直连 `raw.githubusercontent.com` 常常超时（本机实测就是超时），所以默认给 jsDelivr 镜像；能直连 GitHub 的话，原文地址同样可用：

```text
https://raw.githubusercontent.com/<owner>/<repo>/main/publish/index.json
```

然后搜索「DeepSeek 官网 / dsh-deepseek-site」安装，装完左侧栏就多一个入口，点开在中央面板里打开 `chat.deepseek.com`。

也可以用一行安装（把 `spec` 换成索引里计算的安装地址）：

```text
git+https://github.com/<owner>/<repo>.git#<40 位 sha>
```

## 4. 注意事项

- **索引地址不能 302 跳转**：宿主拒绝重定向，所以别用 `github.com/.../raw/...`。`raw.githubusercontent.com` 与 jsDelivr 都是直接 200。
- **jsDelivr 有缓存**：`@main` 分支的缓存约 12 小时（`s-maxage=43200`）。刚发布新版本对方看不到时，可以访问 `https://purge.jsdelivr.net/gh/<owner>/<repo>@main/publish/index.json` 清缓存，或让对方删掉索引源重新添加。
- **登录快照是本机行为**：插件把 `chat.deepseek.com` 的 `userToken` 快照存在本机 DSH 应用的 localStorage 里，跨应用重启回填。它不会随插件分发给别人，也不该分发——别人装好后需要自己登录一次，之后重启就保持登录。
- **Electron 权限**：内嵌网页走的是 DSH 主进程的 `browser.acquire` 授权通道（`window.dshDesktop.browser`），与右侧栏 Browser 使用同一套隔离策略（沙箱、禁用 nodeIntegration、仅允许 http/https、下载与权限全部拒绝）。所以它只在 DSH 桌面端生效，Web 端会显示「当前环境不支持内嵌」的提示。
- **图标**：`icon.svg` 会内联进索引；如果以后换更大的图标，注意 format 1 对内联图标的限制是解码后 ≤32 KiB。

## 5. 常见安装失败

索引里的版本是 `git` 来源，宿主在 pnpm 之前会先跑一次 `git ls-remote` 预检（`githubConnectionTimeoutMs`，默认 5 秒）；预检失败会直接中止，pnpm 根本没开始。

**`dsh: connection to github.com timed out after 5000ms`**：本机 git 的 Windows `schannel` 后端拿不到 TLS 凭证（`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`）。只对 GitHub 换成 OpenSSL，不动全局默认值：

```bash
git config --global http.https://github.com/.sslBackend openssl
git -c credential.helper= ls-remote https://github.com/<owner>/<repo>.git HEAD
```

第二条能打印出提交 SHA 就说明预检可过。想回滚这条配置：`git config --global --unset http.https://github.com/.sslBackend`。

**`[ERR_PNPM_EPERM] importPackage ... rename '...dsh-<name>_tmp_*' -> '...dsh-<name>'`**：profile 的 `node_modules/<name>` 是开发期留下的软链接（junction），pnpm 无法原地替换，只能先删链接本身（`cmd /c rmdir "<profile>\node_modules\dsh-deepseek-site"`，删的是链接不是源码目录），再重装。

**`Packages: +1 -N` 且把包移进 `node_modules/.ignored`**：这是失败后的回滚把临时包清掉，跟着上面的原因一起解决即可；它本身不代表依赖被破坏。

## 6. 版本升级

```bash
# 1) 改 package.json 的 version
# 2) 重新生成索引（publishTimestamp 会更新）
node publish/build-index.mjs --git https://github.com/<owner>/<repo> \
  --index-url https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/publish/index.json
# 3) 一起提交
git add package.json publish/index.json && git commit -m "release: v1.5.1" && git push
# 4) 想让对方立刻看到，清一次 jsDelivr 缓存
curl https://purge.jsdelivr.net/gh/<owner>/<repo>@main/publish/index.json
```

同一插件只保留一条记录、`versions` 里可以放多个版本；宿主按 SemVer 降序取可用项。

## 7. 预构建包（可选，但强烈建议）

索引里的版本是 `git` 来源，用户装的时候要先过 `git ls-remote` 预检——本机遇到的那两次失败（schannel 凭证、profile 软链接）都出在这一步。发一个预构建包就能完全绕开 git：

```bash
npm pack --cache .dsh-tmp/npm-cache
# 资产名故意不带版本号，latest/download 才长期有效
cp dsh-deepseek-site-<version>.tgz dsh-deepseek-site.tgz
gh release create v<version> dsh-deepseek-site.tgz --title "v<version>" --notes "…"
```

之后这个地址长期可用（每次发版覆盖同名资产即可）：

```text
https://github.com/<owner>/<repo>/releases/latest/download/dsh-deepseek-site.tgz
```

在 DSH 的**添加插件**里它和 npm 包名、Git 地址并列被接受（包名 / Git 地址 / 压缩包 / 本地绝对路径）。`package.json` 里没有 `@deepseek-ai/*` 依赖，所以包内无需 `peerDependencies` 处理。

## 8. 收录进 awesome-dsh-plugin

[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 是社区插件列表，`dsh-market` 的货架与截图都从这里取。收录是**一个 PR 加一个文件**，README 由对方脚本生成，不要手工改。

条目已经按它的格式写好：[`WJMACTD__dsh-deepseek-site.yml`](./WJMACTD__dsh-deepseek-site.yml)。提交位置是对方仓库的 `data/plugins/WJMACTD__dsh-deepseek-site.yml`。

对方 CI 的硬性检查（按顺序）：

| 检查 | 我们这边 |
| --- | --- |
| 仓库声明 `dsh.bundle` | ✅ `package.json` 有 `dsh.bundle.patch` + 根目录 `cordis.patch.yml` |
| 仓库创建满 1 天 | ⏳ 仓库 2026-10-29 16:53 建，10-30 16:53 之后才达标 |
| 加 `dsh-plugin` topic | ✅ 已加（另有 `deepseek-harness`、`webview`） |
| 有真实可用代码 | ✅ 947 行 client 半 + 单测 `test-signin.cjs` |
| 一个 PR ≤3 条 | ✅ 只提交 1 条 |

提交步骤：

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false
gh repo clone WJMACTD/awesome-dsh-plugin -- --depth 1
cp publish/WJMACTD__dsh-deepseek-site.yml awesome-dsh-plugin/data/plugins/
cd awesome-dsh-plugin && git checkout -b add-wjmactd-deepseek-site \
  && git add data/plugins/WJMACTD__dsh-deepseek-site.yml \
  && git commit -m "Add WJMACTD/dsh-deepseek-site" && git push -u origin add-wjmactd-deepseek-site
gh pr create --title "Add WJMACTD/dsh-deepseek-site" --body "…"
```

注意几点：

- **别手工改 README**，也别在本地跑生成脚本后一起提交——历史上 218/296 个 PR 就是这么变成冲突的。
- **图标**必须是 GitHub 托管位图：`assets/icon-180.png` 已就位，SVG 会被拒。
- **截图**可选且随时能加、不用再提 PR：在仓库根放 `screenshots.json`（1–8 张图），下一次构建自动生效。
- **同类条目已经有好几个**（`jaychang1989/dsh-webchat` 与本插件功能几乎一致，10 星且在维护；另有 `Jakcet/dsh-dschat`、`YokiMohan/dsh-webview`、`Starp1ume/dsh-chat-mode`）。规则是「同类撞车时谁更好收录谁，不是先来后到」，但同类重复是评审时最容易被并掉的一条——提交时把差异讲清楚（白名单式登录快照、可手动「忘记本机登录」、15 秒增量捕获、失败回退卡片、预构建 tarball 免 git 安装）。
- CI 红不一定是你的问题：`READMEs match data/plugins` 落后由维护者合并时重生成；`gate` 一栏是 `—` 说明分支冲突，需要维护者 rebase。

