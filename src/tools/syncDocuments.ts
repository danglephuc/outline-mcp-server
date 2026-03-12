import fs from 'node:fs/promises';
import path from 'node:path';
import { type AxiosInstance } from 'axios';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getOutlineClient } from '../outline/outlineClient.js';
import toolRegistry from '../utils/toolRegistry.js';
import z from 'zod';

const ESSENTIAL_FIELDS = [
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

function slugify(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

// Hàm normalize tên file/folder: loại bỏ dấu, thay ký tự đặc biệt, chuyển về chữ thường
function normalizeName(name: string): string {
  // Giữ số thứ tự đầu nếu có
  let match = name.match(/^\d+/);
  let prefix = match ? match[0] + '-' : '';
  let result = name;
  // Loại emoji và ký tự unicode ngoài chữ/số
  result = result.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1F1E6}-\u{1F1FF}]/gu, '');
  // Loại bỏ dấu tiếng Việt
  const from = 'áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝỲỶỸỴ';
  const to   = 'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyAAAAAAAAAAAAAAAAADEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYY';
  for (let i = 0; i < from.length; i++) {
    result = result.replace(new RegExp(from[i], 'g'), to[i]);
  }
  // Xóa số thứ tự đầu (đã lấy ở prefix)
  result = result.replace(/^\d+\s*/, '');
  // Thay thế ký tự đặc biệt và khoảng trắng bằng '-'
  result = result.replace(/[^a-zA-Z0-9]+/g, '-');
  // Loại bỏ dấu '-' ở đầu/cuối
  result = result.replace(/^-+|-+$/g, '');
  // Ghép prefix và chuyển về chữ thường, viết hoa chữ cái đầu mỗi từ
  result = prefix + result;
  result = result.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
  return result;
}

function formatDocument(data: Record<string, any>): string {
  const yamlLines = ESSENTIAL_FIELDS.filter(key => data[key] !== undefined).map(key => {
    const value = data[key];
    if (value === null) return `${key}: null`;
    if (typeof value === 'string') return `${key}: ${JSON.stringify(value)}`;
    return `${key}: ${value}`;
  });

  const documentContent = data.text ?? '';
  return `---\n${yamlLines.join('\n')}\n---\n\n${documentContent}`;
}

async function fetchAllChildren(
  client: AxiosInstance,
  parentDocumentId: string
): Promise<Record<string, any>[]> {
  const all: Record<string, any>[] = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const response = await client.post('/documents.list', {
      parentDocumentId,
      limit,
      offset,
      sort: 'index',
      direction: 'ASC',
    });
    const docs: Array<Record<string, any>> = Array.isArray(response.data?.data)
      ? response.data.data
      : [];
    all.push(...docs);
    if (docs.length < limit) break;
    offset += limit;
  }

  return all;
}

interface SavedFile {
  filePath: string;
  content: string;
}

async function saveDocumentTree(
  client: AxiosInstance,
  docData: Record<string, any>,
  folderPath: string,
  urlMap: Map<string, string>,
  savedFiles: SavedFile[],
  rootOutputFolder?: string
): Promise<void> {
  // Fetch full document when possible (list may omit body/text). Fall back to docData if server errors (e.g. 500).
  let doc: Record<string, any>;
  try {
    const res = await client.post<{ data: Record<string, any> }>('/documents.info', { id: docData.id });
    doc = res.data?.data;
  } catch {
    doc = docData;
  }
  if (!doc) {
    throw new Error(`documents.info returned no data for id ${docData.id}`);
  }

    let normalizedFolderPath = folderPath;
    // Preserve user's outputFolder path as-is (including casing). Only normalize path segments derived from document titles.
    const isRootFolder = rootOutputFolder != null && path.resolve(folderPath) === path.resolve(rootOutputFolder);
    if (!isRootFolder && folderPath) {
      const parts = folderPath.split(path.sep);
      if (parts.length > 1) {
        const prefix = parts.slice(0, parts.length - 1);
        const cloudPart = normalizeName(parts[parts.length - 1]);
        normalizedFolderPath = path.join(...prefix, cloudPart);
        // path.join('', 'home', ...) drops the leading slash; preserve absolute paths
        if (path.isAbsolute(folderPath)) {
          normalizedFolderPath = path.resolve(path.sep, normalizedFolderPath);
        }
      } else {
        normalizedFolderPath = parts[0];
      }
  }
  // Normalize file name using the document title, falling back to ID if title is missing
  const slug = normalizeName(doc.title) || doc.id;
  const content = formatDocument(doc);

  // Fetch children first so we only create a subfolder when the document has children
  const children = await fetchAllChildren(client, doc.id);

  const hasChildren = children.length > 0;
  // Always save this document as parent/slug.md; children (if any) go in parent/slug/*.md
  const filePath = path.join(normalizedFolderPath, `${slug}.md`);

  // Map the document's full URL and its path portion to the local file path
  if (doc.url) {
    urlMap.set(doc.url, filePath);
    try {
      const urlPath = new URL(doc.url).pathname;
      urlMap.set(urlPath, filePath);
    } catch {
      // url might not be a full URL; just skip path extraction
    }
  }
  if (doc.id) {
    urlMap.set(doc.id, filePath);
  }

  await fs.mkdir(normalizedFolderPath, { recursive: true });
  if (hasChildren) {
    await fs.mkdir(path.join(normalizedFolderPath, slug), { recursive: true });
  }
  await fs.writeFile(filePath, content, 'utf-8');
  savedFiles.push({ filePath, content });

  if (hasChildren) {
    const docDir = path.join(normalizedFolderPath, slug);
    for (const child of children) {
      await saveDocumentTree(client, child, docDir, urlMap, savedFiles, rootOutputFolder);
    }
  }
}

function deriveBaseUrl(): string {
  const apiUrl = process.env.OUTLINE_API_URL || 'https://app.getoutline.com/api';
  return apiUrl.replace(/\/api\/?$/, '');
}

async function resolveLinks(
  savedFiles: SavedFile[],
  urlMap: Map<string, string>,
  baseUrl: string
): Promise<number> {
  let totalResolved = 0;

  // Build a regex that matches full Outline URLs or relative /doc/ paths
  // Full: https://outline.example.com/doc/slug-id or https://outline.example.com/doc/slug-id#heading
  // Relative: /doc/slug-id
  const escapedBase = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:${escapedBase})?/doc/([a-zA-Z0-9_-]+(?:-[a-zA-Z0-9_-]+)*)`,
    'g'
  );

  for (const { filePath, content } of savedFiles) {
    // Only resolve links in the markdown body, not in YAML frontmatter
    let frontmatter = '';
    let body = content;
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) {
      frontmatter = fmMatch[0];
      body = content.slice(frontmatter.length);
    }

    let fileResolved = 0;

    const updated = body.replace(pattern, (match, slugOrId: string) => {
      // Try exact match on the full matched URL
      if (urlMap.has(match)) {
        fileResolved++;
        return path.relative(path.dirname(filePath), urlMap.get(match)!);
      }

      // Try with baseUrl prefix if the match is relative
      const fullUrl = match.startsWith('/') ? `${baseUrl}${match}` : match;
      if (urlMap.has(fullUrl)) {
        fileResolved++;
        return path.relative(path.dirname(filePath), urlMap.get(fullUrl)!);
      }

      // Try the path portion
      try {
        const urlPath = new URL(match, 'http://dummy').pathname;
        if (urlMap.has(urlPath)) {
          fileResolved++;
          return path.relative(path.dirname(filePath), urlMap.get(urlPath)!);
        }
      } catch {
        // not a valid URL, skip
      }

      // Try matching by just the captured slug/id (could be a UUID)
      if (urlMap.has(slugOrId)) {
        fileResolved++;
        return path.relative(path.dirname(filePath), urlMap.get(slugOrId)!);
      }

      return match; // no replacement found
    });

    if (fileResolved > 0) {
      await fs.writeFile(filePath, frontmatter + updated, 'utf-8');
      totalResolved += fileResolved;
    }
  }

  return totalResolved;
}

// Register this tool
toolRegistry.register('sync_documents', {
  name: 'sync_documents',
  description:
    'Sync a document and all its nested child documents from Outline to a local folder. ' +
    'Saves each document as a Markdown file with YAML frontmatter. ' +
    'The local folder structure mirrors the parent-child hierarchy. ' +
    'After saving, Outline cloud URLs in the content are replaced with local relative paths.',
  inputSchema: {
    id: z
      .string()
      .describe('Unique identifier for the root document. Either the UUID or the urlId is acceptable'),
    outputFolder: z
      .string()
      .refine(v => path.isAbsolute(v), {
        message: 'outputFolder must be an absolute path',
      })
      .describe('Absolute path to the local folder where documents will be saved'),
  },
  async callback(args) {
    try {
      const client = getOutlineClient();

      // Fetch root document
      const response = await client.post('/documents.info', { id: args.id });
      const rootDoc = response.data.data;

      const outputFolder = path.resolve(args.outputFolder);
      const urlMap = new Map<string, string>();
      const savedFiles: SavedFile[] = [];

      // Pass 1: Save all documents recursively and build URL map
      await saveDocumentTree(client, rootDoc, outputFolder, urlMap, savedFiles, outputFolder);

      // Pass 2: Resolve Outline URLs to local relative paths
      const baseUrl = deriveBaseUrl();
      const linksResolved = await resolveLinks(savedFiles, urlMap, baseUrl);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              totalFiles: savedFiles.length,
              linksResolved,
              outputFolder,
              files: savedFiles.map(f => f.filePath),
            }),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error syncing documents:', error.message);
      throw new McpError(ErrorCode.InvalidRequest, error.message);
    }
  },
});
