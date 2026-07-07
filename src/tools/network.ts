/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toCurl, toFetch} from '../formatters/CurlFormatter.js';
import {toHar} from '../formatters/HarFormatter.js';
import {zod} from '../third_party/index.js';
import type {ResourceType} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const FILTERABLE_RESOURCE_TYPES: readonly [ResourceType, ...ResourceType[]] = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'fedcm',
  'other',
];

export const listNetworkRequests = definePageTool({
  name: 'list_network_requests',
  description: `List all requests for the currently selected page since the last navigation.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of requests to return. When omitted, returns all requests.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
      ),
    includePreservedRequests: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved requests over the last 3 navigations.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    const data = await request.page.getDevToolsData();
    response.attachDevToolsData(data);
    const reqid = data?.cdpRequestId
      ? context.resolveCdpRequestId(request.page, data.cdpRequestId)
      : undefined;
    response.setIncludeNetworkRequests(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      resourceTypes: request.params.resourceTypes,
      includePreservedRequests: request.params.includePreservedRequests,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});

export const getNetworkRequest = definePageTool({
  name: 'get_network_request',
  description: `Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.',
      ),
    requestFilePath: zod
      .string()
      .optional()
      .describe(
        'The absolute or relative path to a .network-request file to save the request body to. If omitted, the body is returned inline.',
      ),
    responseFilePath: zod
      .string()
      .optional()
      .describe(
        'The absolute or relative path to a .network-response file to save the response body to. If omitted, the body is returned inline.',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: ['requestFilePath', 'responseFilePath'],
  handler: async (request, response, context) => {
    if (request.params.reqid) {
      response.attachNetworkRequest(request.params.reqid, {
        requestFilePath: request.params.requestFilePath,
        responseFilePath: request.params.responseFilePath,
      });
    } else {
      const data = await request.page.getDevToolsData();
      response.attachDevToolsData(data);
      const reqid = data?.cdpRequestId
        ? context.resolveCdpRequestId(request.page, data.cdpRequestId)
        : undefined;
      if (reqid) {
        response.attachNetworkRequest(reqid, {
          requestFilePath: request.params.requestFilePath,
          responseFilePath: request.params.responseFilePath,
        });
      } else {
        response.appendResponseLine(
          `Nothing is currently selected in the DevTools Network panel.`,
        );
      }
    }
  },
});

export const toSnippet = definePageTool({
  name: 'to_snippet',
  description: `Generate a runnable curl or fetch code snippet that reproduces a captured network request. Sensitive headers (authorization, cookie, ...) are redacted by default; set includeSensitiveHeaders to true to reproduce authenticated requests.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of the network request (see list_network_requests). If omitted, uses the request currently selected in the DevTools Network panel.',
      ),
    format: zod
      .enum(['curl', 'fetch'])
      .optional()
      .describe('Output format. Defaults to curl.'),
    includeSensitiveHeaders: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Include sensitive headers (authorization, cookie, ...) verbatim so the snippet works for authenticated endpoints. Defaults to false (redacted).',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response, context) => {
    let reqid = request.params.reqid;
    if (reqid === undefined) {
      const data = await request.page.getDevToolsData();
      response.attachDevToolsData(data);
      reqid = data?.cdpRequestId
        ? context.resolveCdpRequestId(request.page, data.cdpRequestId)
        : undefined;
    }
    if (reqid === undefined) {
      response.appendResponseLine(
        'Nothing is currently selected in the DevTools Network panel. Provide a reqid.',
      );
      return;
    }

    const httpRequest = context.getNetworkRequestById(request.page, reqid);
    const format = request.params.format ?? 'curl';
    const options = {
      includeSensitiveHeaders: request.params.includeSensitiveHeaders ?? false,
    };
    const snippet =
      format === 'fetch'
        ? await toFetch(httpRequest, options)
        : await toCurl(httpRequest, options);

    response.appendResponseLine(`Snippet (${format}) for reqid=${reqid}:`);
    response.appendResponseLine(format === 'fetch' ? '```js' : '```sh');
    response.appendResponseLine(snippet);
    response.appendResponseLine('```');
  },
});

export const exportHar = definePageTool({
  name: 'export_har',
  description: `Export the captured network requests for the selected page to a HAR (HTTP Archive) file on disk. Sensitive headers are redacted by default; response bodies are omitted unless includeResponseBodies is set.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod
      .string()
      .describe(
        'The absolute or relative path to write the HAR file to. A .har extension is enforced.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Only include requests of these resource types. When omitted, includes all.',
      ),
    includePreservedRequests: zod
      .boolean()
      .default(false)
      .optional()
      .describe('Include the preserved requests over the last 3 navigations.'),
    includeResponseBodies: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Include response bodies in the HAR (produces a larger file). Defaults to false.',
      ),
    includeSensitiveHeaders: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Include sensitive headers (authorization, cookie, ...) verbatim. Defaults to false (redacted).',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: ['filePath'],
  handler: async (request, response, context) => {
    const all = context.getNetworkRequests(
      request.page,
      request.params.includePreservedRequests,
    );
    const resourceTypes = request.params.resourceTypes;
    let requests = all;
    if (resourceTypes && resourceTypes.length) {
      const wanted = new Set<string>(resourceTypes);
      requests = all.filter(item => wanted.has(item.resourceType()));
    }

    const har = await toHar(requests, {
      includeSensitiveHeaders: request.params.includeSensitiveHeaders ?? false,
      includeResponseBodies: request.params.includeResponseBodies ?? false,
    });
    const bytes = Buffer.from(JSON.stringify(har, null, 2), 'utf-8');
    const {filename} = await context.saveFile(
      bytes,
      request.params.filePath,
      '.har',
    );
    response.appendResponseLine(
      `Exported ${requests.length} network request(s) to ${filename}.`,
    );
  },
});
