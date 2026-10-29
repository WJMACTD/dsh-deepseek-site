# DSH 插件市场索引 · DSH plugin market index

一个符合 DSH **format 1** 规范的插件市场索引源。把它加到 DSH「插件 → 发现 → 添加索引源」即可浏览和安装。

A format-1 DSH plugin market index. Add it in **Plugins → Discover → Add index source**.

```text
https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/publish/index.json
```

> 把 `<owner>/<repo>` 换成你自己的仓库。默认给 jsDelivr 镜像是因为国内直连 `raw.githubusercontent.com` 经常超时；能直连时原文地址 `https://raw.githubusercontent.com/<owner>/<repo>/main/publish/index.json` 等价。两种都不能用 `github.com/.../raw/...` 的重定向地址——宿主拒绝重定向。

## 收录的插件

| 包名 | 说明 |
| --- | --- |
| `dsh-deepseek-site` | 左侧栏入口，在应用窗口内嵌 `chat.deepseek.com`，并跨重启保留登录。 |

## 这个文件怎么来的

`index.json` 由本目录的 `build-index.mjs` 生成，**发布前用 DSH 自带的真实校验器 `parseMarketIndex` 校验过**，不是手写 JSON。

重新生成（npm 源）：

```bash
node build-index.mjs
```

使用 Git 源而不是 npm 源时（`--commit` 省略即取本仓库 `git rev-parse HEAD`，避免手抄 SHA）：

```bash
node build-index.mjs \
  --git https://github.com/<owner>/<repo> \
  --index-url https://raw.githubusercontent.com/<owner>/<repo>/main/publish/index.json
```

完整的发布流程见 [RELEASE.md](./RELEASE.md)。

## format 1 的关键约束（摘自 DSH 校验器）

- 顶层必须有 `format: 1` 和 `title`；`title`/`description` 是「字符串或语言对象」，语言对象**必须含 `en`**。
- `plugins[].name` 必须是合法 npm 包名，索引内唯一。
- `versions[]` 非空、版本号唯一、按 SemVer 降序（校验器会自己排序）。
- 每项 `{ version, publishTimestamp(整数 Unix 秒), source, engines? }`。
- `source`：`{type:'npm', registry?}` 或 `{type:'git', url(规范 https、无凭据/查询/片段、路径≥2 段), commit(40 位小写 hex), path?}`。
- `icon`：`data:` 内联仅 svg/png/jpeg/webp + base64 且 ≤32 KiB；否则相对索引 URL 解析，必须 https 或与索引同源。
- 索引里**不要写** `installation` / `defaultVersion` —— 那是宿主每次查询时算出来的。
- `metadata.category` 必须是 `metadata.categories` 里已声明的 id。

## 本地校验

```bash
node -e '
const {readFileSync}=require("node:fs");
const i=JSON.parse(readFileSync("index.json","utf8"));
if(i.format!==1||!Array.isArray(i.plugins))throw Error("Invalid index shape");
console.log({plugins:i.plugins.length,versions:i.plugins.reduce((n,p)=>n+p.versions.length,0)});
'
```

完整校验（推荐，和宿主同一套规则）：直接跑 `build-index.mjs`，它加载的就是从 DSH 安装包里取出的 `parseMarketIndex`。

## 许可

索引文件本身 MIT；各插件版权与许可证以各自仓库声明为准。收录不代表安全审查或兼容性保证。
