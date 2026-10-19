import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error handling request:', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });

  // Idempotent graceful shutdown preventing 'Error: Server is not running' on double SIGINT/SIGTERM
  let isClosing = false;
  const gracefulShutdown = (signal) => {
    if (isClosing) return;
    isClosing = true;
    console.log(`Received ${signal}. Shutting down gracefully...`);
    if (server.listening) {
      server.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING' && !err.message?.includes('Server is not running')) {
          console.error('Error during server close:', err);
        }
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    if (err?.code === 'ERR_SERVER_NOT_RUNNING' || err?.message?.includes('Server is not running')) {
      return;
    }
    console.error('Uncaught Exception:', err);
  });
});
