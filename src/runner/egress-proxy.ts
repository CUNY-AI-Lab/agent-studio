import http, { IncomingMessage, RequestOptions, ServerResponse } from 'http';
import https from 'https';
import net from 'net';
import { lookup } from 'dns/promises';
import { Duplex } from 'stream';

const BLOCKED_EXACT_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'host.docker.internal',
  'gateway.docker.internal',
]);

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
];

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

export interface EgressAssessment {
  allowed: boolean;
  hostname: string;
  connectHost?: string;
  reason?: string;
}

export interface EgressProxyHandle {
  port: number;
  close: () => Promise<void>;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const withoutBrackets = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return withoutBrackets.replace(/\.$/, '').toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return true;
  if (BLOCKED_EXACT_HOSTS.has(normalized)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;

  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = normalizeHostname(ip);

  if (normalized === '::1' || normalized === '::') return true;

  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length));
  }

  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('fec')
    || normalized.startsWith('fed')
    || normalized.startsWith('fee')
    || normalized.startsWith('fef');
}

function isPrivateOrInternalIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

async function resolvePublicAddress(hostname: string): Promise<EgressAssessment> {
  const normalized = normalizeHostname(hostname);

  if (isBlockedHostname(normalized)) {
    return {
      allowed: false,
      hostname: normalized,
      reason: `Blocked internal hostname ${normalized}`,
    };
  }

  if (net.isIP(normalized)) {
    if (isPrivateOrInternalIp(normalized)) {
      return {
        allowed: false,
        hostname: normalized,
        reason: `Blocked internal IP ${normalized}`,
      };
    }

    return {
      allowed: true,
      hostname: normalized,
      connectHost: normalized,
    };
  }

  const resolved = await lookup(normalized, { all: true, verbatim: true });
  if (resolved.length === 0) {
    return {
      allowed: false,
      hostname: normalized,
      reason: `Could not resolve ${normalized}`,
    };
  }

  const blockedAddress = resolved.find((address) => isPrivateOrInternalIp(address.address));
  if (blockedAddress) {
    return {
      allowed: false,
      hostname: normalized,
      reason: `Resolved ${normalized} to blocked address ${blockedAddress.address}`,
    };
  }

  return {
    allowed: true,
    hostname: normalized,
    connectHost: resolved[0].address,
  };
}

export async function assessEgressDestination(hostname: string): Promise<EgressAssessment> {
  try {
    return await resolvePublicAddress(hostname);
  } catch (error) {
    return {
      allowed: false,
      hostname: normalizeHostname(hostname),
      reason: error instanceof Error ? error.message : 'DNS resolution failed',
    };
  }
}

function writeProxyError(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(message);
}

function stripProxyHeaders(headers: IncomingMessage['headers']): RequestOptions['headers'] {
  const nextHeaders = { ...headers };
  delete nextHeaders['proxy-connection'];
  delete nextHeaders['proxy-authorization'];
  return nextHeaders;
}

function parseTargetFromRequest(request: IncomingMessage): {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  path: string;
} {
  if (!request.url) {
    throw new Error('Missing proxy request URL');
  }

  if (/^https?:\/\//i.test(request.url)) {
    const targetUrl = new URL(request.url);
    return {
      protocol: targetUrl.protocol as 'http:' | 'https:',
      hostname: targetUrl.hostname,
      port: Number.parseInt(targetUrl.port, 10) || (targetUrl.protocol === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
      path: `${targetUrl.pathname}${targetUrl.search}`,
    };
  }

  const hostHeader = request.headers.host;
  if (!hostHeader) {
    throw new Error('Missing host header');
  }

  const targetUrl = new URL(`http://${hostHeader}${request.url}`);
  return {
    protocol: 'http:',
    hostname: targetUrl.hostname,
    port: Number.parseInt(targetUrl.port, 10) || DEFAULT_HTTP_PORT,
    path: `${targetUrl.pathname}${targetUrl.search}`,
  };
}

function writeConnectError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let target: ReturnType<typeof parseTargetFromRequest>;
  try {
    target = parseTargetFromRequest(request);
  } catch (error) {
    writeProxyError(response, 400, error instanceof Error ? error.message : 'Invalid proxy request');
    return;
  }

  const assessment = await assessEgressDestination(target.hostname);
  if (!assessment.allowed || !assessment.connectHost) {
    writeProxyError(response, 403, assessment.reason || 'Blocked destination');
    return;
  }

  const upstreamRequest = (target.protocol === 'https:' ? https : http).request({
    host: assessment.connectHost,
    port: target.port,
    method: request.method,
    path: target.path,
    headers: {
      ...stripProxyHeaders(request.headers),
      host: request.headers.host || target.hostname,
    },
    servername: target.protocol === 'https:' ? target.hostname : undefined,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstreamRequest.on('error', (error) => {
    writeProxyError(response, 502, error.message);
  });

  request.pipe(upstreamRequest);
}

async function handleConnectRequest(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer
): Promise<void> {
  if (!request.url) {
    writeConnectError(clientSocket, 400, 'Bad Request');
    return;
  }

  const [rawHost, rawPort] = request.url.split(':');
  const hostname = normalizeHostname(rawHost);
  const port = Number.parseInt(rawPort || `${DEFAULT_HTTPS_PORT}`, 10);

  if (!hostname || Number.isNaN(port) || port <= 0 || port > 65535) {
    writeConnectError(clientSocket, 400, 'Bad Request');
    return;
  }

  const assessment = await assessEgressDestination(hostname);
  if (!assessment.allowed || !assessment.connectHost) {
    writeConnectError(clientSocket, 403, 'Forbidden');
    return;
  }

  const upstreamSocket = net.connect(port, assessment.connectHost);

  upstreamSocket.once('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => {
    writeConnectError(clientSocket, 502, 'Bad Gateway');
  });

  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
}

export async function startEgressProxy(): Promise<EgressProxyHandle> {
  const server = http.createServer((request, response) => {
    void handleHttpRequest(request, response);
  });

  server.on('connect', (request, clientSocket, head) => {
    void handleConnectRequest(request, clientSocket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    throw new Error('Failed to determine egress proxy port');
  }

  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
