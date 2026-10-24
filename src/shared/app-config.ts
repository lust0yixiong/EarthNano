// Single source of truth for project identity and external links. Shared by the main process
// (GitHub star-count fetch) and the renderer (every entry-point link). Keep this UI-free — no
// icons, no JSX — so both processes can import it and any screen reuses the same values.

import { DEFAULT_LOCALE, type Locale } from './locale'

const GITHUB_OWNER = 'lust0yixiong'
const GITHUB_REPO = 'EarthNano'
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`
const CDN_BASE_URL = 'https://statics.aipoch.com/open-science'
const ALPHA_UPDATE_URL = `${GITHUB_REPO_URL}/releases/download/alpha`

export const APP = {
  name: 'OneEarth',
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  cdnBaseUrl: CDN_BASE_URL,
  links: {
    website: GITHUB_REPO_URL,
    docs: 'https://www.aipoch.com/docs/',
    githubRepo: GITHUB_REPO_URL,
    license: `${GITHUB_REPO_URL}/blob/main/LICENSE`,
    githubReleases: `${GITHUB_REPO_URL}/releases`,
    githubApi: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
    githubIssues: `${GITHUB_REPO_URL}/issues`,
    githubFeedback: `${GITHUB_REPO_URL}/issues/new?template=feature_request.yml`,
    discord: 'https://discord.gg/85dKfuGM9',
    x: 'https://x.com/aipoch_ai'
  },
  copyright: '© 2026 AIPOCH',
  update: {
    manifestUrl: `${ALPHA_UPDATE_URL}/version.json`,
    downloadPage: `${GITHUB_REPO_URL}/releases`
  }
} as const

// The documentation site uses the same locale identifiers as the app. English lives at the root;
// translated homepages use a locale subdirectory. Callers supply the already-resolved app locale.
export const getDocumentationUrl = (locale: Locale): string =>
  `${APP.links.docs}${locale === DEFAULT_LOCALE ? '' : `${locale}/`}`
