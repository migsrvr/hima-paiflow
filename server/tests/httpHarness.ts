import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type { Express } from 'express';

// Exercise the real Express HTTP pipeline without binding a port. This works in
// restricted environments and still covers JSON parsing, routing, and headers.
export async function request(app: Express, path: string, init: RequestInit = {}) {
  return new Promise<{ status: number; headers: Headers; json: () => Promise<any> }>((resolve, reject) => {
    const output: Buffer[] = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
    });
    const req = new IncomingMessage(socket as Socket);
    const body = typeof init.body === 'string' ? init.body : '';
    req.method = init.method ?? 'GET';
    req.url = path;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.complete = true;
    req.headers = Object.fromEntries(new Headers(init.headers).entries());
    if (body) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    const timeout = setTimeout(() => reject(new Error(`HTTP harness timed out: ${req.method} ${path}`)), 2000);
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(output).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, split).split('\r\n');
      const status = Number(head.shift()?.split(' ')[1]);
      const headers = new Headers();
      for (const line of head) {
        const colon = line.indexOf(':');
        if (colon !== -1) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      const responseBody = raw.slice(split + 4);
      resolve({ status, headers, json: async () => JSON.parse(responseBody) });
      socket.destroy();
    });
    req.push(body ? Buffer.from(body) : null);
    if (body) req.push(null);
    app(req, res);
  });
}
