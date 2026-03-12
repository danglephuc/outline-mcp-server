import fs from 'node:fs/promises';
import path from 'node:path';
import { type AxiosInstance } from 'axios';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getOutlineClient } from '../outline/outlineClient.js';
import toolRegistry from '../utils/toolRegistry.js';
import z from 'zod';

type Frontmatter = Record<string, any>;

const OUTLINE_METADATA_FIELDS = [
  'id',
  'title',
  'url',
  'collectionId',
  'parentDocumentId',
  'revision',
  'template',
  'createdAt',
  'updatedAt',
];

interface LocalDocNode {
  filePath: string;
  meta: Frontmatter;
  body: string;
  children: LocalDocNode[];
  cloudId?: string;
  cloudUrl?: string;
}

function truncate(value: string, maxLength = 600): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function formatApiError(error: any, context?: string): string {
  const status = error?.response?.status;
  const statusText = error?.response?.statusText;
  const headers = error?.response?.headers || {};
  const responseData = error?.response?.data;
  const message = String(error?.message || 'Unknown error');

  let responseText = '';
  if (responseData !== undefined) {
    if (typeof responseData === 'string') {
      responseText = truncate(responseData);
    } else {
      try {
        responseText = truncate(JSON.stringify(responseData));
      } catch {
        responseText = '[unserializable response data]';
      }
    }
  }

  const retryAfter = headers['retry-after'];
  const rateRemaining = headers['x-ratelimit-remaining'];
  const rateReset = headers['x-ratelimit-reset'];
  const requestId = headers['x-request-id'] || headers['cf-ray'];

  const parts = [
    context ? `[${context}]` : '',
    `message=${message}`,
    status ? `status=${status}` : '',
    statusText ? `statusText=${statusText}` : '',
    retryAfter !== undefined ? `retryAfter=${retryAfter}` : '',
    rateRemaining !== undefined ? `rateRemaining=${rateRemaining}` : '',
    rateReset !== undefined ? `rateReset=${rateReset}` : '',
    requestId ? `requestId=${requestId}` : '',
    responseText ? `response=${responseText}` : '',
  ].filter(Boolean);

  return parts.join(' | ');
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

async function postWithContext(
  client: AxiosInstance,
  endpoint: string,
  payload: Record<string, any>,
  requestContext?: string
): Promise<any> {
  try {
    return await client.post(endpoint, payload);
  } catch (error: any) {
    const context = [requestContext, `endpoint=${endpoint}`].filter(Boolean).join(', ');
    throw new Error(formatApiError(error, context));
  }
}

function parseScalar(raw: string): any {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);

  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }

  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }

  return raw;
}

function parseMarkdown(content: string): { meta: Frontmatter; body: string; hasFrontmatter: boolean } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { meta: {}, body: content, hasFrontmatter: false };
  }

  const meta: Frontmatter = {};
  const yaml = match[1];
  const lines = yaml.split('\n');

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    meta[key] = parseScalar(rawValue);
  }

  return { meta, body: content.slice(match[0].length), hasFrontmatter: true };
}

function formatFrontmatter(meta: Frontmatter): string {
  const mergedKeys = [
    ...OUTLINE_METADATA_FIELDS,
    ...Object.keys(meta).filter(k => !OUTLINE_METADATA_FIELDS.includes(k)),
  ];

  const lines = mergedKeys
    .filter(key => meta[key] !== undefined)
    .map(key => {
      const value = meta[key];
      if (value === null) return `${key}: null`;
      if (typeof value === 'string') return `${key}: ${JSON.stringify(value)}`;
      return `${key}: ${value}`;
    });

  return `---\n${lines.join('\n')}\n---\n\n`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkMarkdownFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function findRootFileByDocumentId(
  inputFolder: string,
  rootDocumentId: string
): Promise<string | undefined> {
  const markdownFiles = await walkMarkdownFiles(inputFolder);

  for (const filePath of markdownFiles) {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseMarkdown(content);
    if (parsed.meta.id === rootDocumentId) {
      return filePath;
    }
  }

  return undefined;
}

async function listDirectMarkdownChildren(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function buildLocalTree(filePath: string): Promise<LocalDocNode> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parseMarkdown(content);

  const node: LocalDocNode = {
    filePath,
    meta: parsed.meta,
    body: parsed.body,
    children: [],
  };

  const childDir = path.join(path.dirname(filePath), path.basename(filePath, '.md'));
  if (await fileExists(childDir)) {
    const childFiles = await listDirectMarkdownChildren(childDir);
    for (const childFile of childFiles) {
      node.children.push(await buildLocalTree(childFile));
    }
  }

  return node;
}

function isNotFoundError(error: any): boolean {
  const status = error?.response?.status;
  const message = String(error?.response?.data?.message || error?.message || '').toLowerCase();
  return status === 404 || message.includes('not found');
}

function getNodeTitle(node: LocalDocNode): string {
  const fromMeta = typeof node.meta.title === 'string' ? node.meta.title.trim() : '';
  if (fromMeta) return fromMeta;
  return path.basename(node.filePath, '.md');
}

async function upsertNode(
  client: AxiosInstance,
  node: LocalDocNode,
  parentCloudId: string | null,
  defaultCollectionId: string,
  options: {
    createMissing: boolean;
    publish?: boolean;
    dryRun: boolean;
  },
  results: {
    updated: string[];
    created: string[];
  }
): Promise<void> {
  const title = getNodeTitle(node);
  const text = node.body;
  const collectionId = String(node.meta.collectionId || defaultCollectionId);

  let targetId: string | undefined =
    typeof node.meta.id === 'string' && node.meta.id.trim() ? node.meta.id.trim() : undefined;

  if (targetId) {
    const intendedParentId = parentCloudId ?? null;

    if (!options.dryRun) {
      const beforeInfoResponse = await postWithContext(
        client,
        '/documents.info',
        { id: targetId },
        `operation=inspect_current_parent, filePath=${node.filePath}, documentId=${targetId}, title=${JSON.stringify(title)}`
      );
      const beforeInfo = beforeInfoResponse.data.data;
      const currentParentId = beforeInfo.parentDocumentId ?? null;
      const currentCollectionId = beforeInfo.collectionId ?? null;

      if (currentParentId !== intendedParentId || currentCollectionId !== collectionId) {
        const movePayload: Record<string, any> = {
          id: targetId,
          collectionId,
        };

        // For top-level documents, omit parentDocumentId to move out of nested folder.
        if (intendedParentId !== null) {
          movePayload.parentDocumentId = intendedParentId;
        }

        await postWithContext(
          client,
          '/documents.move',
          movePayload,
          `operation=move_to_match_local_parent, filePath=${node.filePath}, documentId=${targetId}, fromParent=${currentParentId ?? 'null'}, toParent=${intendedParentId ?? 'null'}, fromCollection=${currentCollectionId ?? 'null'}, toCollection=${collectionId}, title=${JSON.stringify(title)}`
        );

        node.meta.parentDocumentId = intendedParentId;
        node.meta.collectionId = collectionId;
      }
    }

    const payload: Record<string, any> = {
      id: targetId,
      title,
      text,
    };

    if (options.publish !== undefined) {
      payload.publish = options.publish;
    }

    try {
      if (!options.dryRun) {
        const response = await postWithContext(
          client,
          '/documents.update',
          payload,
          `operation=update_existing, filePath=${node.filePath}, documentId=${targetId}, title=${JSON.stringify(title)}`
        );
        const data = response.data.data;
        node.cloudId = data.id || targetId;
        node.cloudUrl = data.url || node.meta.url;

        // Refresh server metadata to keep local frontmatter consistent after
        // moves and updates (especially parentDocumentId).
        const infoResponse = await postWithContext(
          client,
          '/documents.info',
          { id: node.cloudId },
          `operation=refresh_updated_metadata, filePath=${node.filePath}, documentId=${node.cloudId}, title=${JSON.stringify(title)}`
        );
        const infoData = infoResponse.data.data;
        node.meta = {
          ...node.meta,
          id: infoData.id,
          title: infoData.title || title,
          url: infoData.url || node.cloudUrl,
          collectionId: infoData.collectionId || collectionId,
          parentDocumentId: infoData.parentDocumentId ?? intendedParentId,
          revision: infoData.revision,
          template: infoData.template,
          createdAt: infoData.createdAt,
          updatedAt: infoData.updatedAt,
        };
      } else {
        node.cloudId = targetId;
        node.cloudUrl = typeof node.meta.url === 'string' ? node.meta.url : undefined;
      }
      results.updated.push(node.filePath);
    } catch (error: any) {
      if (!options.createMissing || !isNotFoundError(error)) {
        throw error;
      }

      targetId = undefined;
    }
  }

  if (!targetId) {
    if (!options.createMissing) {
      throw new Error(`Document missing id and createMissing=false: ${node.filePath}`);
    }

    const payload: Record<string, any> = {
      title,
      text,
      collectionId,
    };

    if (parentCloudId) {
      payload.parentDocumentId = parentCloudId;
    }

    if (options.publish !== undefined) {
      payload.publish = options.publish;
    }

    if (!options.dryRun) {
      const response = await postWithContext(
        client,
        '/documents.create',
        payload,
        `operation=create_new, filePath=${node.filePath}, parentDocumentId=${parentCloudId ?? 'null'}, collectionId=${collectionId}, title=${JSON.stringify(title)}`
      );
      const data = response.data.data;
      node.cloudId = data.id;
      node.cloudUrl = data.url;

      // Read back server state to ensure local frontmatter is fully accurate
      // even when the source file had no or incomplete metadata.
      const infoResponse = await postWithContext(
        client,
        '/documents.info',
        { id: data.id },
        `operation=refresh_created_metadata, filePath=${node.filePath}, documentId=${data.id}, title=${JSON.stringify(title)}`
      );
      const infoData = infoResponse.data.data;

      node.meta = {
        ...node.meta,
        id: infoData.id,
        title: infoData.title || title,
        url: infoData.url || data.url,
        collectionId: infoData.collectionId || collectionId,
        parentDocumentId: infoData.parentDocumentId ?? parentCloudId,
        revision: infoData.revision,
        template: infoData.template,
        createdAt: infoData.createdAt,
        updatedAt: infoData.updatedAt,
      };
    } else {
      node.cloudId = `dry-run:${path.basename(node.filePath, '.md')}`;
    }

    results.created.push(node.filePath);
  }

  for (const child of node.children) {
    await upsertNode(client, child, node.cloudId || null, defaultCollectionId, options, results);
  }
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function toDocPath(urlOrPath: string): string {
  const u = String(urlOrPath || '').trim();
  if (!u) return u;
  if (u.startsWith('/doc/')) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  }
  if (u.startsWith('/')) return u;
  return u;
}

function convertLocalLinksToCloud(
  text: string,
  sourceFilePath: string,
  cloudUrlByFile: Map<string, string>,
): string {
  const markdownLinkPattern = /(!?\[[^\]]*\])\(([^)]+)\)/g;

  const convertedMarkdownLinks = text.replace(markdownLinkPattern, (fullMatch, label, rawTarget) => {
    let target = String(rawTarget).trim();

    if (!target) return fullMatch;
    if (target.startsWith('http://') || target.startsWith('https://')) return fullMatch;
    if (target.startsWith('/doc/')) return fullMatch;
    if (target.startsWith('#')) return fullMatch;
    if (target.startsWith('mailto:')) return fullMatch;

    const hashIndex = target.indexOf('#');
    const targetPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const targetHash = hashIndex >= 0 ? target.slice(hashIndex) : '';

    if (!targetPath.toLowerCase().endsWith('.md')) return fullMatch;

    const sourceDir = path.dirname(sourceFilePath);
    const tryResolve = (p: string) => normalizePath(path.resolve(sourceDir, p));

    // Primary resolution (normal relative link)
    let absTarget = tryResolve(targetPath);
    let cloudUrl = cloudUrlByFile.get(absTarget);

    // Fallback: handle links like "./<current-folder>/<file>.md" which can happen when local link rewriting
    // accidentally duplicates the current folder name.
    if (!cloudUrl) {
      const currentFolder = path.basename(sourceDir);
      const normalizedTarget = targetPath.replace(/^[.][\\/]/, ''); // drop leading "./" or ".\"
      const prefix = `${currentFolder}/`;
      if (normalizedTarget.startsWith(prefix)) {
        const withoutDup = normalizedTarget.slice(prefix.length);
        absTarget = tryResolve(withoutDup);
        cloudUrl = cloudUrlByFile.get(absTarget);
      }
    }

    if (!cloudUrl) return fullMatch;

    // When pushing to Outline, we only need the doc path (no domain).
    const docPath = toDocPath(cloudUrl);
    return `${label}(${docPath}${targetHash})`;
  });

  // Second pass: convert bare relative `.md` references (not wrapped in Markdown link syntax).
  // We only touch paths that start with ./, ../, .\, ..\ to avoid over-matching normal text.
  //
  // Examples matched:
  // - ./Parent/Child.md
  // - ../Sibling.md#heading
  // - .\Parent\Child.md
  const bareRelativeMdPattern = /(?<!\()(\.{1,2}[\\/][^\s)\]"']+?\.md)(#[^\s)\]"']+)?/gi;

  return convertedMarkdownLinks.replace(bareRelativeMdPattern, (fullMatch, rawPath: string, rawHash: string) => {
    const targetPath = String(rawPath).trim();
    const targetHash = rawHash ? String(rawHash) : '';

    if (!targetPath) return fullMatch;

    const sourceDir = path.dirname(sourceFilePath);
    const tryResolve = (p: string) => normalizePath(path.resolve(sourceDir, p));

    let absTarget = tryResolve(targetPath);
    let cloudUrl = cloudUrlByFile.get(absTarget);

    if (!cloudUrl) {
      // Same fallback as markdown conversion for duplicated current folder name.
      const currentFolder = path.basename(sourceDir);
      const normalizedTarget = targetPath.replace(/^[.][\\/]/, '').replace(/\\/g, '/');
      const prefix = `${currentFolder}/`;
      if (normalizedTarget.startsWith(prefix)) {
        const withoutDup = normalizedTarget.slice(prefix.length);
        absTarget = tryResolve(withoutDup);
        cloudUrl = cloudUrlByFile.get(absTarget);
      }
    }

    if (!cloudUrl) return fullMatch;

    return `${toDocPath(cloudUrl)}${targetHash}`;
  });
}

function flattenTree(root: LocalDocNode): LocalDocNode[] {
  const all: LocalDocNode[] = [];

  function visit(node: LocalDocNode) {
    all.push(node);
    for (const child of node.children) visit(child);
  }

  visit(root);
  return all;
}

// Register this tool
toolRegistry.register('sync_documents_to_cloud', {
  name: 'sync_documents_to_cloud',
  description:
    'Sync local Markdown documents to Outline cloud. Updates documents when frontmatter id exists, and creates missing documents while preserving folder-based hierarchy.',
  inputSchema: {
    rootDocumentId: z
      .string()
      .describe('Root document ID (UUID or urlId) in Outline to anchor the sync tree'),
    rootPath: z
      .string()
      .refine(isAbsolutePath, { message: 'rootPath must be an absolute path' })
      .describe(
        'Absolute path to either (1) the local root markdown file, or (2) the local folder containing synced markdown files. If a folder is provided, the root file is auto-detected by rootDocumentId.'
      ),
    createMissing: z
      .boolean()
      .optional()
      .describe('Create documents in Outline for local files that do not have frontmatter id (default: true)'),
    publish: z
      .boolean()
      .optional()
      .describe('Whether to publish documents when creating/updating'),
    syncLinksToCloud: z
      .boolean()
      .optional()
      .describe('Convert local .md links in content to Outline /doc links before cloud update (default: true)'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Validate and plan changes without calling create/update endpoints'),
  },
  async callback(args) {
    try {
      const client = getOutlineClient();
      const createMissing = args.createMissing ?? true;
      const syncLinksToCloud = args.syncLinksToCloud ?? true;
      const dryRun = args.dryRun ?? false;

      const rootInfoResponse = await postWithContext(
        client,
        '/documents.info',
        { id: args.rootDocumentId },
        `operation=fetch_root_info, rootDocumentId=${args.rootDocumentId}`
      );
      const rootInfo = rootInfoResponse.data.data;
      const defaultCollectionId = rootInfo.collectionId;

      const resolvedRootPath = path.resolve(args.rootPath);
      const isMarkdownFile = resolvedRootPath.toLowerCase().endsWith('.md');

      const inputFolder = isMarkdownFile ? path.dirname(resolvedRootPath) : resolvedRootPath;
      let rootFilePath: string | undefined = isMarkdownFile ? resolvedRootPath : undefined;

      if (!rootFilePath) rootFilePath = await findRootFileByDocumentId(inputFolder, String(rootInfo.id));

      if (!rootFilePath) {
        throw new Error(
          `Could not find local root file in ${inputFolder} with frontmatter id=${rootInfo.id}. Provide rootPath as the root .md file instead.`
        );
      }

      const rootNode = await buildLocalTree(rootFilePath);
      rootNode.meta.id = String(rootInfo.id);
      rootNode.meta.collectionId = rootNode.meta.collectionId || defaultCollectionId;

      const results = {
        updated: [] as string[],
        created: [] as string[],
        linkUpdated: [] as string[],
      };

      await upsertNode(
        client,
        rootNode,
        rootInfo.parentDocumentId ?? null,
        defaultCollectionId,
        {
          createMissing,
          publish: args.publish,
          dryRun,
        },
        results
      );

      if (syncLinksToCloud && !dryRun) {
        const allNodes = flattenTree(rootNode);
        const cloudUrlByFile = new Map<string, string>();

        for (const node of allNodes) {
          if (node.cloudUrl) {
            // Store as /doc/... path so uploads don't include a domain.
            cloudUrlByFile.set(normalizePath(node.filePath), toDocPath(node.cloudUrl));
          }
        }

        for (const node of allNodes) {
          if (!node.cloudId) continue;
          const converted = convertLocalLinksToCloud(node.body, node.filePath, cloudUrlByFile);
          if (converted === node.body) continue;

          const updatePayload = {
            id: node.cloudId,
            text: converted,
            title: getNodeTitle(node),
          };

          await postWithContext(
            client,
            '/documents.update',
            updatePayload,
            `operation=update_links, filePath=${node.filePath}, documentId=${node.cloudId}, title=${JSON.stringify(getNodeTitle(node))}`
          );

          results.linkUpdated.push(node.filePath);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              dryRun,
              rootFilePath,
              totalUpdated: results.updated.length,
              totalCreated: results.created.length,
              totalLinkUpdated: results.linkUpdated.length,
              updated: results.updated,
              created: results.created,
              linkUpdated: results.linkUpdated,
            }),
          },
        ],
      };
    } catch (error: any) {
      const debugMessage = formatApiError(error, 'sync_documents_to_cloud');
      console.error('Error syncing local documents to cloud:', debugMessage);
      throw new McpError(ErrorCode.InvalidRequest, debugMessage);
    }
  },
});
