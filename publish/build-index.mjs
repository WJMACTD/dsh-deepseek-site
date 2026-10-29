/**
 * Build a format-1 DSH plugin market index from a plugin directory.
 *
 * Usage (from the workspace root):
 *   node plugins/dsh-deepseek-site/publish/build-index.mjs [--git <url> --commit <sha> --path <dir>]
 *
 * Defaults to an npm source. Every generated document is checked with the
 * real validator extracted from the DSH installation
 * (`.publish-tools/market-index-validator.mjs`), so a bad document fails here
 * instead of inside the host's Worker.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

/**
 * Inline the plugin icon as a base64 data URL. The index is a single file that
 * may be hosted anywhere, so inlining avoids shipping a second copy of
 * `icon.svg` beside it (and the drift that comes with two copies). Format 1
 * caps a decoded inline icon at 32 KiB.
 */
function inlineIcon() {
  let bytes
  try {
    bytes = readFileSync(join(pluginDir, 'icon.svg'))
  } catch {
    return undefined
  }
  if (bytes.length > 32 * 1024) return undefined
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

const icon = inlineIcon()

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const gitUrl = arg('git')
const gitPath = arg('path')

if (gitUrl && !/^https:\/\/[^/]+(\/[^/]+){2,}$/u.test(gitUrl)) {
  throw new Error(`--git must be a canonical https repository URL, got ${gitUrl}`)
}

/**
 * The git commit to install from. `--commit` wins; otherwise take HEAD from the
 * plugin repository, which removes the copy-paste step (and the stale SHA that
 * comes with it) from the release flow. A repo without commits has no pin, so
 * this refuses instead of guessing.
 */
function headCommit() {
  try {
    return execFileSync('git', ['-C', pluginDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      '--commit is required: the plugin directory has no git HEAD. Commit and push first, then rerun, or pass --commit <sha>.',
    )
  }
}

const commit = gitUrl ? (arg('commit') ?? headCommit()) : undefined

if (gitUrl && !/^[0-9a-f]{40}$/u.test(commit ?? '')) {
  throw new Error(`--commit must be a lowercase 40-hex commit SHA, got ${commit}`)
}

const source = gitUrl
  ? { type: 'git', url: gitUrl, commit, ...(gitPath ? { path: gitPath } : {}) }
  : { type: 'npm', registry: 'https://registry.npmjs.org/' }

// Optional display metadata. Nothing here is hard-coded to one account: the
// repository URL is taken from --git, and --homepage / --author override the
// manifest when the plugin is published under a different identity.
const homepage = arg('homepage') ?? manifest.homepage
const repositoryUrl = arg('repository') ?? (gitUrl ? gitUrl : undefined)
const author = arg('author') ?? manifest.author

const index = {
  format: 1,
  title: {
    en: arg('title') ?? `${manifest.name} index`,
    zh: arg('title-zh') ?? `${manifest.name} 索引`,
  },
  description: {
    en: `Plugin index for ${manifest.name}.`,
    zh: `${manifest.name} 的插件索引。`,
  },
  metadata: {
    categories: {
      'ui-experience': { title: { en: 'UI & experience', zh: '界面与体验' } },
      integrations: { title: { en: 'Integrations', zh: '集成与分享' } },
    },
    labels: {
      webview: { title: { en: 'Webview', zh: '内嵌网页' } },
      deepseek: { title: { en: 'DeepSeek', zh: 'DeepSeek' } },
    },
  },
  plugins: [
    {
      name: manifest.name,
      title: {
        en: 'DeepSeek Site in the sidebar',
        zh: '左侧栏 DeepSeek 官网',
      },
      description: {
        en: 'Adds a left-sidebar entry that embeds chat.deepseek.com inside the app window and keeps the sign-in across restarts.',
        zh: '在左侧栏增加一个入口，把 chat.deepseek.com 内嵌到应用窗口内，并跨重启保留登录。',
      },
      ...(icon ? { icon } : {}),
      ...(author ? { author } : {}),
      ...(homepage ? { homepage } : {}),
      ...(repositoryUrl ? { repository: { url: repositoryUrl } } : {}),
      metadata: {
        category: 'ui-experience',
        keywords: ['deepseek', 'webview', 'sidebar', 'official site', 'login'],
        labels: ['webview', 'deepseek'],
      },
      versions: [
        {
          version: manifest.version,
          // The index is a market claim; keep this the real publish time.
          publishTimestamp: Math.floor(Date.now() / 1000),
          source,
          ...(manifest.engines?.dsh ? { engines: { dsh: manifest.engines.dsh } } : {}),
        },
      ],
    },
  ],
}

const validator = await import(pathToFileURL(join(here, 'market-index-validator.mjs')).href)
// Base URL for resolving a relative icon; a placeholder is enough because the
// icon is served from the same repository as the index.
const indexUrl = arg('index-url') ?? 'https://raw.githubusercontent.com/placeholder/index/index.json'
const validated = validator.parseMarketIndex(index, indexUrl)

const out = join(here, 'index.json')
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

const first = validated.plugins[0]
const target = validator.marketInstallTarget(first.name, first.versions[0])
console.log(`wrote ${out}`)
console.log(`validated: ${validated.plugins.length} plugin(s), ${first.versions.length} version(s)`)
console.log(`install spec: ${target.spec}${target.registry ? ` (registry ${target.registry})` : ''}`)
