import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getOutlineClient } from '../outline/outlineClient.js';
import toolRegistry from '../utils/toolRegistry.js';
import z from 'zod';

// Register this tool
toolRegistry.register('get_document', {
  name: 'get_document',
  description: 'Get details about a specific document. Either id or shareId is required.',
  inputSchema: {
    id: z
      .string()
      .optional()
      .describe('Unique identifier for the document. Either the UUID or the urlId is acceptable'),
    shareId: z
      .string()
      .optional()
      .describe('Share ID for the document (used for shared/public documents)'),
    outputPath: z
      .string()
      .refine(v => path.isAbsolute(v), {
        message: 'outputPath must be an absolute path',
      })
      .optional()
      .describe(
        'Optional absolute file path to save the document as YAML frontmatter + Markdown body, reducing LLM context size.'
      ),
  },
  async callback(args) {
    try {
      if (!args.id && !args.shareId) {
        throw new McpError(ErrorCode.InvalidRequest, 'Either id or shareId is required');
      }

      const client = getOutlineClient();

      const payload: Record<string, string> = {};
      if (args.id) payload.id = args.id;
      if (args.shareId) payload.shareId = args.shareId;

      const response = await client.post('/documents.info', payload);
      const data = response.data.data;

      if (args.outputPath) {
        const resolvedOutput = path.resolve(args.outputPath);

        // Only include essential metadata fields
        const essentialFields = [
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

        const yamlLines = essentialFields
          .filter(key => data[key] !== undefined)
          .map(key => {
            const value = data[key];
            if (value === null) return `${key}: null`;
            // JSON.stringify produces valid YAML double-quoted scalars, handling all
            // special characters (backslashes, newlines, tabs, quotes, etc.)
            if (typeof value === 'string') return `${key}: ${JSON.stringify(value)}`;
            return `${key}: ${value}`;
          });

        const documentContent = data.text ?? '';
        const fileContent = `---\n${yamlLines.join('\n')}\n---\n\n${documentContent}`;

        await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
        await fs.writeFile(resolvedOutput, fileContent, 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, savedTo: resolvedOutput }),
            },
          ],
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error: any) {
      console.error('Error getting document:', error.message);
      throw new McpError(ErrorCode.InvalidRequest, error.message);
    }
  },
});
