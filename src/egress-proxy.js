const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { resolvePublicAddresses } = require('./security');

function matchesCredentials(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const actual = Buffer.from(header.slice(6));
  const wanted = Buffer.from(`clipdown:${expected}`).toString('base64');
  const expectedBuffer = Buffer.from(wanted);
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function parseTarget(authority, defaultPort, allowedPorts = [80, 443]) {
  let url;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  const port = Number(url.port || defaultPort);
  if (!url.hostname || !allowedPorts.includes(port) || url.username || url.password) return null;
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port };
}

function sendError(socket, status, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  }
}

async function publicTarget(authority, defaultPort, resolver, allowedPorts) {
  const target = parseTarget(authority, defaultPort, allowedPorts);
  if (!target) return null;
  const addresses = await resolver(target.hostname);
  if (!addresses.length) return null;
  return { ...target, address: addresses[0].address, family: addresses[0].family };
}

function createEgressProxy({ resolver = resolvePublicAddresses, allowedPorts = [80, 443] } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const sockets = new Set();
  const diagnostics = [];
  function recordDiagnostic(type, destination) {
    if (diagnostics.length >= 32) diagnostics.shift();
    diagnostics.push({ type, destination: destination || null });
  }

  const server = http.createServer((request, response) => {
    if (!matchesCredentials(request.headers['proxy-authorization'], token)) {
      recordDiagnostic('proxy_authentication_rejected');
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Cliply"', Connection: 'close' }).end();
      return;
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      recordDiagnostic('proxy_request_invalid');
      response.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:' || url.username || url.password) {
      recordDiagnostic('proxy_protocol_rejected', url.hostname);
      response.writeHead(403).end();
      return;
    }
    publicTarget(url.host, 80, resolver, allowedPorts).then((target) => {
      if (!target) {
        recordDiagnostic('proxy_destination_rejected', url.hostname);
        response.writeHead(403).end();
        return;
      }
      const headers = { ...request.headers, host: url.host, connection: 'close' };
      delete headers['proxy-authorization'];
      const upstream = http.request({
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        timeout: 60000,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family)
      }, (upstreamResponse) => {
        if (upstreamResponse.statusCode === 403) {
          recordDiagnostic('upstream_http_403', target.hostname);
        }
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('timeout', () => upstream.destroy(new Error('Proxy upstream timed out.')));
      upstream.on('error', () => {
        recordDiagnostic('proxy_upstream_failed', target.hostname);
        if (!response.headersSent) response.writeHead(502).end();
        else response.destroy();
      });
      request.pipe(upstream);
      response.on('close', () => upstream.destroy());
    }).catch((error) => {
      recordDiagnostic(
        error?.code === 'URL_UNREACHABLE' ? 'proxy_destination_unresolved' : 'proxy_destination_rejected',
        url.hostname
      );
      if (!response.headersSent) response.writeHead(403).end();
    });
  });

  server.on('connect', async (request, client, head) => {
    if (!matchesCredentials(request.headers['proxy-authorization'], token)) {
      recordDiagnostic('proxy_authentication_rejected');
      sendError(client, '407 Proxy Authentication Required', 'Proxy authentication required');
      return;
    }

    let target;
    try {
      target = await publicTarget(request.url, 443, resolver, allowedPorts);
    } catch (error) {
      const authority = parseTarget(request.url, 443, allowedPorts);
      recordDiagnostic(
        error?.code === 'URL_UNREACHABLE' ? 'proxy_destination_unresolved' : 'proxy_destination_rejected',
        authority?.hostname
      );
      sendError(client, '403 Forbidden', 'Destination is not allowed');
      return;
    }
    if (!target) {
      const authority = parseTarget(request.url, 443, allowedPorts);
      recordDiagnostic('proxy_destination_rejected', authority?.hostname);
      sendError(client, '403 Forbidden', 'Destination is not allowed');
      return;
    }

    const upstream = net.connect({ host: target.address, port: target.port });
    sockets.add(upstream);
    sockets.add(client);
    upstream.setTimeout(60000);
    client.setTimeout(60000);
    let tunnelEstablished = false;
    const cleanup = () => {
      sockets.delete(upstream);
      sockets.delete(client);
      upstream.destroy();
      client.destroy();
    };
    upstream.once('connect', () => {
      if (client.destroyed) {
        cleanup();
        return;
      }
      recordDiagnostic('https_tunnel_established', target.hostname);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunnelEstablished = true;
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', () => {
      recordDiagnostic('proxy_upstream_timeout', target.hostname);
      cleanup();
    });
    upstream.on('error', () => {
      recordDiagnostic('proxy_upstream_failed', target.hostname);
      if (tunnelEstablished) cleanup();
      else sendError(client, '502 Bad Gateway', 'Destination connection failed');
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (!tunnelEstablished && !client.destroyed) client.destroy();
    });
    client.on('error', cleanup);
    client.on('close', cleanup);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const proxyUrl = new URL(`http://127.0.0.1:${port}`);
      proxyUrl.username = 'clipdown';
      proxyUrl.password = token;
      resolve({
        url: proxyUrl.href,
        diagnostics,
        close: async () => {
          const closed = new Promise((done) => server.close(() => done()));
          server.closeAllConnections?.();
          for (const socket of sockets) socket.destroy();
          await closed;
        }
      });
    });
  });
}

module.exports = { createEgressProxy, parseTarget, publicTarget };
