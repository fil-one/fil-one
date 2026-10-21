#!/usr/bin/env node

// The deterministic steps of .github/workflows/docs-sync.yaml. Claude's output
// is untrusted, because the PR it reads can carry prompt injection: everything
// Claude returns passes through this script before it reaches a comment, a PR,
// or the docs repo. Design and threat model: docs/DocsSync.md.
//
// Usage: node .github/docs-sync/docs-sync.mjs <command>
//   prepare      write .docs-sync/pr.json and .docs-sync/pr.diff for Claude
//   gate         validate the triage result, decide whether to draft, comment
//   check-draft  check the drafted docs change before it is built or pushed
//   pr-body      print the docs PR title and body
//   finalize     update the sticky comment with the outcome of the draft
//
// Inputs come from environment variables, never from command-line
// interpolation in the workflow, so no PR text reaches a shell.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WORK_DIR = '.docs-sync';
const DOCS_DIR = 'docs-site';
const DOCS_REPO = 'FilecoinFoundationWeb/filone-docs';
const COMMENT_MARKER = '<!-- docs-sync -->';

// Paths the draft may change. Everything else in the docs repo is either
// executed by the build (docusaurus.config.js, sidebars.js, src/) or is
// configuration, so a person makes those changes.
const EDITABLE_PATH =
  /^(docs\/[a-z0-9][a-z0-9/_-]*\.mdx?|static\/llms\.txt|static\/llms-full\.txt)$/;
// Paths triage may point at. Wider than EDITABLE_PATH because triage reports
// claims in docusaurus.config.js even though the draft may not edit it.
const REFERENCEABLE_PATH = /^(docs\/.+\.mdx?|static\/llms(-full)?\.txt|docusaurus\.config\.js)$/;
const NEW_PAGE_PATH = /^docs\/[a-z0-9][a-z0-9/-]*\.mdx$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const MAX_DIFF_BYTES = 400_000;
const MAX_PR_BODY_CHARS = 4_000;
const MAX_ITEMS = 25;
const MAX_TEXT_CHARS = 400;

// Hosts a drafted page may link to without a warning in the docs PR.
const KNOWN_LINK_HOSTS = ['fil.one', 'github.com/FilecoinFoundationWeb', 'github.com/fil-one'];

// ── prepare ──────────────────────────────────────────────────────────────────

function prepare() {
  const base = requireEnv('BASE_SHA');
  const head = requireEnv('HEAD_SHA');
  mkdirSync(WORK_DIR, { recursive: true });

  const pr = JSON.parse(
    gh([
      'pr',
      'view',
      requireEnv('PR_NUMBER'),
      '--repo',
      requireEnv('GITHUB_REPOSITORY'),
      '--json',
      'number,title,body,url,labels,author',
    ]),
  );
  const meta = {
    number: pr.number,
    title: pr.title,
    body: (pr.body ?? '').slice(0, MAX_PR_BODY_CHARS),
    url: pr.url,
    author: pr.author.login,
    labels: pr.labels.map((label) => label.name),
  };
  writeFileSync(join(WORK_DIR, 'pr.json'), JSON.stringify(meta, null, 2));

  let diff = execFileSync(
    'git',
    [
      '-C',
      'pr',
      'diff',
      '--merge-base',
      base,
      head,
      `--pathspec-from-file=${join(process.cwd(), '.github/docs-sync/paths.txt')}`,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = `${Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString('utf8')}\n\n[diff truncated at ${MAX_DIFF_BYTES} bytes; read the changed files in pr/ for the rest]\n`;
  }
  writeFileSync(join(WORK_DIR, 'pr.diff'), diff);
  console.log(`pr.diff: ${Buffer.byteLength(diff)} bytes`);
}

// ── gate ─────────────────────────────────────────────────────────────────────

function gate() {
  const { triage, dropped } = sanitizeTriage(parseTriageResult(process.env.TRIAGE_RESULT));
  const held = process.env.HELD === 'true';
  const force = process.env.FORCE === 'true';
  const docsLinked = process.env.DOCS_LINKED === 'true';
  const gatedByTriage = triage.gated && process.env.UNGATED !== 'true';

  const draftable = triage.impact === 'affected' || (force && triage.impact === 'unsure');
  const blockedByGate = !force && (held || gatedByTriage);
  const blockedByLinkedDocs = !force && docsLinked;
  const shouldDraft = draftable && !blockedByGate && !blockedByLinkedDocs;

  writeFileSync(join(WORK_DIR, 'triage.json'), JSON.stringify(triage, null, 2));

  if (gatedByTriage && !held && !force) addLabel('docs:gated');
  const status = describeGateStatus(triage.impact, { blockedByLinkedDocs, blockedByGate });
  upsertComment(renderComment(triage, status, dropped));

  setOutput('should_draft', String(shouldDraft));
  console.log(
    `impact=${triage.impact} gated=${triage.gated} held=${held} force=${force} docs_linked=${docsLinked} should_draft=${shouldDraft}`,
  );
}

// An empty or malformed result (Claude ran out of turns, say) still gets a
// comment, as "unclear", rather than failing silently.
function parseTriageResult(text) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return { impact: 'unsure', summary: 'Triage returned no usable result; see the workflow run.' };
  }
}

function describeGateStatus(impact, { blockedByLinkedDocs, blockedByGate }) {
  if (impact === 'none') return 'No docs changes needed.';
  if (impact === 'unsure') {
    return 'Triage could not tell whether the docs need changes; a person should check. To draft anyway, run the **Docs sync** workflow for this PR with `force` checked.';
  }
  if (blockedByLinkedDocs) {
    return 'This PR links a docs PR, so nothing is drafted. Check that the linked docs PR covers the claims below.';
  }
  if (blockedByGate) {
    return 'Held: this change looks feature-gated, so no docs PR is opened yet (a public docs PR announces the feature). At launch, run the **Docs sync** workflow for this PR with `force` checked. If the feature is already public, add the `docs:ungated` label and push or re-run.';
  }
  return 'Drafting a docs PR… this comment updates when it is ready.';
}

function sanitizeTriage(raw) {
  let dropped = 0;
  const impact = ['none', 'affected', 'unsure'].includes(raw?.impact) ? raw.impact : 'unsure';
  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .filter((item) => {
      const ok =
        typeof item?.page === 'string' &&
        REFERENCEABLE_PATH.test(item.page) &&
        existsSync(join(DOCS_DIR, item.page));
      if (!ok) dropped++;
      return ok;
    })
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      page: item.page,
      claim: clean(item.claim),
      change: clean(item.change),
      surface: ['console', 's3-api', 'both', 'other'].includes(item.surface)
        ? item.surface
        : 'other',
      evidence: clean(item.evidence, 200),
    }));
  const newPages = (Array.isArray(raw?.new_pages) ? raw.new_pages : [])
    .filter((page) => {
      const ok =
        typeof page?.path === 'string' &&
        NEW_PAGE_PATH.test(page.path) &&
        !existsSync(join(DOCS_DIR, page.path));
      if (!ok) dropped++;
      return ok;
    })
    .slice(0, 5)
    .map((page) => ({ path: page.path, topic: clean(page.topic) }));

  // A verdict of "affected" whose every item was dropped has nothing to draft from.
  const effectiveImpact =
    impact === 'affected' && items.length === 0 && newPages.length === 0 ? 'unsure' : impact;
  return {
    triage: {
      impact: effectiveImpact,
      gated: raw?.gated === true,
      gated_reason: clean(raw?.gated_reason),
      summary: clean(raw?.summary, 1_000),
      items,
      new_pages: newPages,
    },
    dropped,
  };
}

function renderComment(triage, status, dropped = 0) {
  const heading = { none: 'none', affected: 'docs need changes', unsure: 'unclear' }[triage.impact];
  const lines = [COMMENT_MARKER, `### Docs impact: ${heading}`, '', status, ''];
  if (triage.summary) lines.push(triage.summary, '');
  if (triage.gated) lines.push(`**Gate:** ${triage.gated_reason || 'feature-gated'}`, '');
  if (triage.items.length > 0) {
    lines.push(
      '| Page | Docs say today | Should say | Surface | Code |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const item of triage.items) {
      lines.push(
        `| [${item.page}](https://github.com/${DOCS_REPO}/blob/main/${item.page}) | ${cell(item.claim)} | ${cell(item.change)} | ${item.surface} | ${cell(item.evidence)} |`,
      );
    }
    lines.push('');
  }
  if (triage.new_pages.length > 0) {
    lines.push(
      '**Suggested new pages:**',
      ...triage.new_pages.map((page) => `- \`${page.path}\`: ${page.topic}`),
      '',
    );
  }
  if (dropped > 0)
    lines.push(
      `_${dropped} triage entr${dropped === 1 ? 'y was' : 'ies were'} dropped because they named a path that does not exist in the docs repo._`,
      '',
    );
  lines.push(
    '<sub>Automated triage of this PR against docs.fil.one by the Docs sync workflow (docs/DocsSync.md); it can be wrong. Labels: `docs:skip` turns it off for this PR, `docs:gated` holds drafts until launch, `docs:ungated` overrides a gated verdict. Label changes apply on the next push or manual run.</sub>',
  );
  return lines.join('\n');
}

// ── check-draft ──────────────────────────────────────────────────────────────

// Runs in the verify job, after the drafted files are copied over a clean
// docs checkout and staged. Fails on any change outside EDITABLE_PATH and on
// executable MDX; records warnings for the docs PR body.
function checkDraft() {
  const nameStatus = git(['diff', '--cached', '--name-status', '--no-renames']).trim();
  const changes = nameStatus === '' ? [] : nameStatus.split('\n').map(parseNameStatus);
  const findings = changes.map(checkChangedFile);
  const problems = findings.flatMap((finding) => finding.problems);
  const warnings = findings.flatMap((finding) => finding.warnings);

  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(
    join(WORK_DIR, 'checks.json'),
    JSON.stringify({ files: changes, warnings }, null, 2),
  );
  setOutput('changed', String(changes.length > 0));

  for (const warning of warnings) console.log(`::warning::${warning}`);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exitCode = 1;
  console.log(
    `${changes.length} changed file(s), ${warnings.length} warning(s), ${problems.length} problem(s)`,
  );
}

function parseNameStatus(line) {
  const [status, path] = line.split('\t');
  return { status, path };
}

function checkChangedFile({ status, path }) {
  if (!EDITABLE_PATH.test(path))
    return { problems: [`${path}: the draft may not change this path`], warnings: [] };
  if (status === 'D' || !/\.mdx?$/.test(path)) return { problems: [], warnings: [] };

  // Lines already on main are not the draft's doing, so only new lines count.
  const before = new Set(status === 'A' ? [] : git(['show', `HEAD:${path}`]).split('\n'));
  const added = linesOutsideCodeFences(readFileSync(join(DOCS_DIR, path), 'utf8')).filter(
    ({ text }) => !before.has(text),
  );
  const problems = [];
  const warnings = [];
  for (const { number, text } of added) {
    const problem = findExecutableMdx(text);
    if (problem) problems.push(`${path}:${number}: ${problem}`);
    // The host only: clean() strips URLs from the PR body, and a reviewer
    // needs to see where the link goes.
    warnings.push(
      ...findUnknownLinkHosts(text).map((host) => `${path}:${number}: new link to ${host}`),
    );
  }
  return { problems, warnings };
}

function findUnknownLinkHosts(text) {
  const urls = text.match(/https?:\/\/[^\s)>\]"']+/g) ?? [];
  return urls.filter((url) => !KNOWN_LINK_HOSTS.some((host) => isUnderHost(url, host))).map(hostOf);
}

const ALLOWED_IMPORT = /^import (Tabs|TabItem) from '@theme\/(Tabs|TabItem)';?$/;
const EXECUTABLE_PATTERNS = [
  [/^\s*export\b/, 'export statement'],
  [/<script\b/i, '<script> tag'],
  [/<iframe\b/i, '<iframe> tag'],
  [/\bon[a-z]+\s*=\s*[{"']/i, 'HTML event attribute'],
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/javascript:/i, 'javascript: URL'],
  [
    /\{[^}]*\b(process|require|import|fetch|eval|Function|window|document|globalThis)\b/,
    'JavaScript expression',
  ],
];

function findExecutableMdx(text) {
  if (/^\s*import\b/.test(text))
    return ALLOWED_IMPORT.test(text.trim()) ? null : 'import statement';
  const match = EXECUTABLE_PATTERNS.find(([pattern]) => pattern.test(text));
  return match ? match[1] : null;
}

function linesOutsideCodeFences(source) {
  const result = [];
  let fence = null;
  source.split('\n').forEach((text, index) => {
    const marker = text.trim().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      return;
    }
    if (fence === null) result.push({ number: index + 1, text });
  });
  return result;
}

function hostOf(url) {
  try {
    return `\`${new URL(url).hostname}\``;
  } catch {
    return 'an unparseable URL';
  }
}

function isUnderHost(url, host) {
  const [hostname, ...path] = host.split('/');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostMatches = parsed.hostname === hostname || parsed.hostname.endsWith(`.${hostname}`);
  return (
    hostMatches &&
    (path.length === 0 ||
      parsed.pathname.startsWith(`/${path.join('/')}/`) ||
      parsed.pathname === `/${path.join('/')}`)
  );
}

// ── pr-body ──────────────────────────────────────────────────────────────────

function printPrBody() {
  const triage = readJson(join(WORK_DIR, 'triage.json'));
  const pr = readJson(join(WORK_DIR, 'pr.json'));
  const checks = readJson(join(WORK_DIR, 'checks.json'));
  const draft = parseJson(requireEnv('DRAFT_RESULT'), 'draft result');
  const author = GITHUB_LOGIN.test(pr.author) ? pr.author : null;
  const productRef = `${requireEnv('GITHUB_REPOSITORY')}#${pr.number}`;

  const title = `docs: ${clean(draft.title, 70) || clean(pr.title, 70)} (${productRef})`;
  const list = (items) => (items.length > 0 ? items.map((item) => `- ${item}`) : ['- None']);
  const body = [
    `<!-- docs-sync:${productRef} -->`,
    `Drafted automatically from ${productRef}${author ? ` by @${author}` : ''}: ${clean(pr.title, 120)}`,
    '',
    '> [!IMPORTANT]',
    '> Written by an AI agent from the product diff. Check every claim against the product before marking this ready. This PR stays a draft until the product PR merges.',
    '',
    '## What changed',
    ...list(
      asArray(draft.changes).map(
        (change) => `\`${clean(change.file, 120)}\`: ${clean(change.description)}`,
      ),
    ),
    '',
    '## Needs verification',
    ...list(asArray(draft.needs_verification).map((entry) => clean(entry))),
    '',
    '## Manual follow-ups (paths the bot may not edit)',
    ...list(asArray(draft.manual_followups).map((entry) => clean(entry))),
    '',
    '## Automated checks',
    `- Changed files: ${checks.files.map((file) => `\`${file.path}\``).join(', ')}`,
    '- `npm run build` passed.',
    ...checks.warnings.slice(0, 20).map((warning) => `- ⚠️ ${clean(warning, 300)}`),
    '',
    '## Triage',
    triage.summary || '_No summary._',
    '',
    '---',
    `<sub>Regenerated on each push to ${productRef} while it is open. A push to this branch by anyone other than the bot stops regeneration, so edit freely. Closing this PR stops it for good. Run: ${requireEnv('RUN_URL')}</sub>`,
  ].join('\n');

  writeFileSync(join(WORK_DIR, 'docs-pr-title.txt'), title);
  writeFileSync(join(WORK_DIR, 'docs-pr-body.md'), body);
}

// ── finalize ─────────────────────────────────────────────────────────────────

function finalize() {
  const triage = readJson(join(WORK_DIR, 'triage.json'));
  const results = {
    draft: process.env.DRAFT_RESULT,
    verify: process.env.VERIFY_RESULT,
    publish: process.env.PUBLISH_RESULT,
  };
  const runUrl = requireEnv('RUN_URL');
  const docsPrUrl = process.env.DOCS_PR_URL ?? '';
  const publishStatus = process.env.PUBLISH_STATUS ?? '';

  let status;
  if (results.draft !== 'success') status = `Drafting failed or was cancelled ([run](${runUrl})).`;
  else if (results.verify !== 'success')
    status = `The draft failed its checks or \`npm run build\`, so nothing was pushed ([run](${runUrl})).`;
  else if (process.env.CHANGED !== 'true')
    status = 'The draft agent concluded no docs edit is needed after reading the code.';
  else if (results.publish !== 'success') status = `Opening the docs PR failed ([run](${runUrl})).`;
  else if (publishStatus === 'human-edits')
    status = `The docs PR has commits from a person, so it was not regenerated: ${docsPrUrl}`;
  else if (publishStatus === 'declined')
    status =
      'A docs PR for this change was closed without merging, so no new one was opened. Reopen it to resume.';
  else status = `Docs PR (draft): ${docsPrUrl}`;

  upsertComment(renderComment(triage, status));
}

// ── helpers ──────────────────────────────────────────────────────────────────

function upsertComment(body) {
  const repo = requireEnv('GITHUB_REPOSITORY');
  const number = requireEnv('PR_NUMBER');
  const ids = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues/${number}/comments`,
    '--jq',
    `.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("${COMMENT_MARKER}"))) | .id`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  const payload = JSON.stringify({ body });
  if (ids.length > 0)
    gh(
      ['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${ids[0]}`, '--input', '-'],
      payload,
    );
  else
    gh(
      ['api', '--method', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', '-'],
      payload,
    );
}

function addLabel(name) {
  try {
    gh([
      'pr',
      'edit',
      requireEnv('PR_NUMBER'),
      '--repo',
      requireEnv('GITHUB_REPOSITORY'),
      '--add-label',
      name,
    ]);
  } catch (error) {
    console.log(`::warning::Could not add label ${name}: ${error.message}`);
  }
}

// Strips what could turn model output into a phishing link, a ping, or markup.
function clean(text, max = MAX_TEXT_CHARS) {
  return String(text ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\bhttps?:\/\/\S+/gi, '[link removed]')
    .replace(/`{3,}/g, '')
    .replace(/@(?=[A-Za-z0-9])/g, '@​')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cell(text) {
  return text.replace(/\|/g, '\\|');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

function git(args) {
  return execFileSync('git', ['-C', DOCS_DIR, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function setOutput(name, value) {
  appendFileSync(requireEnv('GITHUB_OUTPUT'), `${name}=${value}\n`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The ${what} is not valid JSON: ${error.message}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Last, so every constant above is initialised before a command reads it.
const commands = { prepare, gate, 'check-draft': checkDraft, 'pr-body': printPrBody, finalize };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: docs-sync.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
command();
