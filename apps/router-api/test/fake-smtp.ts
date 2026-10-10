import { createServer, type Server, type Socket } from 'node:net';

/** One message as the server received it. */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** The raw RFC 5322 message, headers and MIME parts. */
  data: string;
  /** `user:password` when the client authenticated, decoded. */
  auth?: string;
}

/**
 * Just enough of an SMTP server (RFC 5321) to receive what nodemailer sends:
 * EHLO, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, RSET, NOOP, QUIT. No TLS — the
 * suite configures `security: none` — and no queue: a message is "delivered"
 * the moment the terminating dot arrives.
 *
 * Hand-written rather than a dependency because this is all a test needs, and
 * because it lets the suite refuse credentials on purpose.
 */
export class FakeSmtpServer {
  readonly received: ReceivedMail[] = [];
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly credentials?: { user: string; password: string }) {}

  async listen(): Promise<number> {
    this.server = createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('fake SMTP server has no port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Resolves once `count` messages have arrived, or rejects after `timeoutMs`. */
  async waitFor(count: number, timeoutMs = 5000): Promise<ReceivedMail[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} message(s), got ${this.received.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.received;
  }

  private session(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');

    let buffer = '';
    let inData = false;
    let pendingLogin: 'user' | 'password' | undefined;
    let loginUser = '';
    let current: ReceivedMail = { from: '', to: [], data: '' };
    let auth: string | undefined;
    const reply = (line: string) => socket.write(`${line}\r\n`);

    const authenticate = (user: string, password: string) => {
      if (this.credentials && (user !== this.credentials.user || password !== this.credentials.password)) {
        reply('535 5.7.8 Authentication credentials invalid');
        return;
      }
      auth = `${user}:${password}`;
      reply('235 2.7.0 Authentication successful');
    };

    reply('220 fake-smtp ESMTP ready');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) {
            return;
          }
          current.data = buffer.slice(0, end).replace(/^\.\./gm, '.');
          current.auth = auth;
          this.received.push(current);
          current = { from: '', to: [], data: '' };
          buffer = buffer.slice(end + 5);
          inData = false;
          reply('250 2.0.0 OK queued');
          continue;
        }

        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) {
          return;
        }
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);

        if (pendingLogin === 'user') {
          loginUser = Buffer.from(line, 'base64').toString();
          pendingLogin = 'password';
          reply(`334 ${Buffer.from('Password:').toString('base64')}`);
          continue;
        }
        if (pendingLogin === 'password') {
          pendingLogin = undefined;
          authenticate(loginUser, Buffer.from(line, 'base64').toString());
          continue;
        }

        const [verb, ...rest] = line.split(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
            socket.write('250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
            break;
          case 'HELO':
            reply('250 fake-smtp');
            break;
          case 'AUTH': {
            const [mechanism, initial] = rest;
            if (mechanism?.toUpperCase() === 'PLAIN' && initial) {
              const [, user, password] = Buffer.from(initial, 'base64').toString().split('\u0000');
              authenticate(user, password);
            } else if (mechanism?.toUpperCase() === 'LOGIN') {
              pendingLogin = 'user';
              reply(`334 ${Buffer.from('Username:').toString('base64')}`);
            } else {
              reply('504 5.5.4 Unrecognized authentication type');
            }
            break;
          }
          case 'MAIL':
            if (this.credentials && !auth) {
              reply('530 5.7.0 Authentication required');
              break;
            }
            current.from = line
              .replace(/^MAIL FROM:\s*/i, '')
              .replace(/[<>]/g, '')
              .split(' ')[0];
            reply('250 2.1.0 OK');
            break;
          case 'RCPT':
            current.to.push(
              line
                .replace(/^RCPT TO:\s*/i, '')
                .replace(/[<>]/g, '')
                .split(' ')[0],
            );
            reply('250 2.1.5 OK');
            break;
          case 'DATA':
            inData = true;
            reply('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            current = { from: '', to: [], data: '' };
            reply('250 2.0.0 OK');
            break;
          case 'NOOP':
            reply('250 2.0.0 OK');
            break;
          case 'QUIT':
            reply('221 2.0.0 Bye');
            socket.end();
            return;
          default:
            reply('502 5.5.2 Command not recognized');
        }
      }
    });
  }
}

/** A loopback port nothing listens on: bound, read, released. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('no port');
  }
  return address.port;
}
