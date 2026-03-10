import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getOutlineClient } from '../outline/outlineClient.js';
import toolRegistry from '../utils/toolRegistry.js';
import z from 'zod';

// Register this tool
toolRegistry.register('get_document', {
  name: 'get_document',
  description: 'Get details about a specific document. At least id XOR shareId are required.',
  inputSchema: {
    id: z
      .string()
      .describe('Unique identifier for the document. Either the UUID or the urlId is acceptable'),
    outputPath: z
      .string()
      .refine(v => path.isAbsolute(v), {
        message: 'outputPath must be an absolute path',
      })
      .optional()
      .describe(
        'Optional absolute file path to save the document details to disk. When provided, the response is written to a file instead of returned as JSON, reducing LLM context size.'
      ),
  },
  async callback(args) {
    try {
      const client = getOutlineClient();
      const response = await client.post('/documents.info', { id: args.id });
      const data = response.data.data;

      if (args.outputPath) {
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
            if (typeof value === 'string') return `${key}: "${value.replace(/"/g, '\\"')}"`;
            return `${key}: ${value}`;
          });

        const documentContent = data.text ?? '';
        const fileContent = `---\n${yamlLines.join('\n')}\n---\n\n${documentContent}`;

        fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
        fs.writeFileSync(args.outputPath, fileContent, 'utf-8');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, savedTo: args.outputPath }),
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
