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

## 5. 版本升级

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
