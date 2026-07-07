/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import {
  DevTools,
  type HTTPRequest,
  type HTTPResponse,
} from '../third_party/index.js';

const RESPONSE_BODY_SIZE_LIMIT = 5_000_000;

export interface HarOptions {
  includeSensitiveHeaders?: boolean;
  includeResponseBodies?: boolean;
}

interface HarNameValue {
  name: string;
  value: string;
}

interface HarPostData {
  mimeType: string;
  text: string;
}

interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: 'base64';
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarNameValue[];
  headers: HarNameValue[];
  queryString: HarNameValue[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarNameValue[];
  headers: HarNameValue[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: {send: number; wait: number; receive: number};
  _resourceType?: string;
}

export interface Har {
  log: {
    version: '1.2';
    creator: {name: string; version: string};
    entries: HarEntry[];
  };
}

function toNameValues(
  headers: Record<string, string>,
  redact: boolean,
): HarNameValue[] {
  const list = Object.entries(headers).map(([name, value]) => ({name, value}));
  return redact ? DevTools.NetworkRequestFormatter.sanitizeHeaders(list) : list;
}

function parseQueryString(url: string): HarNameValue[] {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

async function loadPostData(
  request: HTTPRequest,
): Promise<HarPostData | undefined> {
  if (!request.hasPostData()) {
    return undefined;
  }
  let text: string | undefined;
  try {
    text = request.postData() ?? (await request.fetchPostData());
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    return undefined;
  }
  const mimeType =
    request.headers()['content-type'] ?? 'application/octet-stream';
  return {mimeType, text};
}

async function loadResponseContent(
  response: HTTPResponse,
  includeBodies: boolean,
): Promise<HarContent> {
  const mimeType = response.headers()['content-type'] ?? '';
  if (!includeBodies) {
    return {size: -1, mimeType};
  }
  try {
    const buffer = await response.buffer();
    if (isUtf8(buffer)) {
      const text = buffer.toString('utf-8');
      const capped =
        text.length > RESPONSE_BODY_SIZE_LIMIT
          ? text.slice(0, RESPONSE_BODY_SIZE_LIMIT)
          : text;
      return {size: buffer.length, mimeType, text: capped};
    }
    return {
      size: buffer.length,
      mimeType,
      text: buffer.toString('base64'),
      encoding: 'base64',
    };
  } catch {
    return {size: -1, mimeType};
  }
}

function emptyResponse(): HarResponse {
  return {
    status: 0,
    statusText: '',
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: [],
    content: {size: 0, mimeType: ''},
    redirectURL: '',
    headersSize: -1,
    bodySize: -1,
  };
}

async function toHarEntry(
  request: HTTPRequest,
  options: HarOptions,
): Promise<HarEntry> {
  const redact = !(options.includeSensitiveHeaders ?? false);
  const includeBodies = options.includeResponseBodies ?? false;
  const httpResponse = request.response();
  const postData = await loadPostData(request);

  const harRequest: HarRequest = {
    method: request.method(),
    url: request.url(),
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: toNameValues(request.headers(), redact),
    queryString: parseQueryString(request.url()),
    ...(postData ? {postData} : {}),
    headersSize: -1,
    bodySize: postData ? Buffer.byteLength(postData.text, 'utf-8') : 0,
  };

  let harResponse: HarResponse;
  if (httpResponse) {
    harResponse = {
      status: httpResponse.status(),
      statusText: httpResponse.statusText(),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toNameValues(httpResponse.headers(), redact),
      content: await loadResponseContent(httpResponse, includeBodies),
      redirectURL: httpResponse.headers()['location'] ?? '',
      headersSize: -1,
      bodySize: -1,
    };
  } else {
    harResponse = emptyResponse();
  }

  return {
    startedDateTime: new Date().toISOString(),
    time: -1,
    request: harRequest,
    response: harResponse,
    cache: {},
    timings: {send: -1, wait: -1, receive: -1},
    _resourceType: request.resourceType(),
  };
}

/** Build a HAR 1.2 archive from captured Puppeteer requests. */
export async function toHar(
  requests: HTTPRequest[],
  options: HarOptions = {},
): Promise<Har> {
  const entries: HarEntry[] = [];
  for (const request of requests) {
    entries.push(await toHarEntry(request, options));
  }
  return {
    log: {
      version: '1.2',
      creator: {name: 'chrome-devtools-mcp', version: '1.0'},
      entries,
    },
  };
}
