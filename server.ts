import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import http from 'http';
import os from 'os';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './server/api';
import { db } from './server/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  // Behind a reverse proxy, set PACE_TRUST_PROXY so req.ip is the real client address.
  // Accepts a hop count (e.g. 1), or an IP/CIDR/keyword list (e.g. "loopback" or "10.0.0.5").
  const trustProxy = (process.env.PACE_TRUST_PROXY || '').trim();
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
  const certPath = process.env.SSL_CERT || path.resolve(process.env.PACE_DATA_DIR || path.join(__dirname, 'data'), 'certs', 'cert.pem');
  const keyPath = process.env.SSL_KEY || path.resolve(process.env.PACE_DATA_DIR || path.join(__dirname, 'data'), 'certs', 'key.pem');
  const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
  if (useHttps) process.env.PACE_HTTPS = '1';

  const inHostedPreview = Boolean(process.env.APP_URL || process.env.K_SERVICE);
  const PORT = inHostedPreview ? 3000 : parseInt(process.env.PORT || '3000', 10);

  app.disable('x-powered-by');
  if (useHttps) app.use((_req, res, next) => { res.setHeader('Strict-Transport-Security', 'max-age=15552000'); next(); });

  const cspMode = (process.env.PACE_CSP || 'on').toLowerCase();
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const devMode = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!inHostedPreview && !devMode) {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (!devMode && !inHostedPreview && cspMode !== 'off') {
      res.setHeader(cspMode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', CSP);
    }
    next();
  });

  const trustedHosts = (process.env.PACE_TRUSTED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Request blocked: it did not come from this application.' });
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch {   }
      const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      if (!originHost || (originHost !== expectedHost && originHost !== req.headers.host && !trustedHosts.includes(originHost))) {
        return res.status(403).json({ error: 'Request blocked: it did not come from this application.' });
      }
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (/^\/auth\/logout\/?$/.test(req.path)) return next();
    const m = db.getMaintenance();
    if (!m) return next();
    res.setHeader('Retry-After', '60');
    return res.status(503).json({ error: 'System under maintenance. Please wait a moment.', maintenance: true });
  });

   
  const bigJson = express.json({ limit: '20mb' });
  const smallJson = express.json({ limit: '2mb' });
  const restoreJson = express.json({ limit: '100mb' });

  const importRaw = express.raw({ type: 'application/octet-stream', limit: '25mb' });
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && /^\/admin\/import\/preview\/?$/.test(req.path)) return importRaw(req, res, next);
    if (req.method === 'POST' && /^\/admin\/import\/(validate|commit)\/?$/.test(req.path)) return bigJson(req, res, next);
    if (req.method === 'POST' && /^\/admin\/restore\/?$/.test(req.path)) return restoreJson(req, res, next);
    if ((req.method === 'POST' || req.method === 'PATCH') && /^\/(transactions|salaries|loans|rent-payments)/.test(req.path)) return bigJson(req, res, next);
    return smallJson(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use('/api', apiRouter);

  app.use('/api', (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
    return next(err);
  });

  app.use('/api', (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Pace IT Ledger] Unhandled API error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found.' }); });

  const distPath = path.resolve(__dirname, 'dist');
  const wantsDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  const hasBuild = fs.existsSync(path.join(distPath, 'index.html'));
  const serveBuilt = !wantsDev && hasBuild;

  if (!wantsDev && !hasBuild) {
    console.error('[Pace IT Ledger] No build found in ./dist. Run "npm run build" first, then "npm start".');
    process.exit(1);
  }

  if (serveBuilt) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        middlewareMode: true,
        fs: { strict: true, deny: ['data/**', '**/data/**', 'server/**', '.env*', '**/*.sqlite*', '**/*.key', '**/*.pem'] },
        watch: process.env.DISABLE_HMR === 'true' ? null : { ignored: ['**/data/**', '**/*.sqlite*', '**/dist/**'] },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const HOST = process.env.HOST || '0.0.0.0';
  const server: http.Server | https.Server = useHttps
    ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
    : http.createServer(app);

  server.listen(PORT, HOST, () => {
    const scheme = useHttps ? 'https' : 'http';
    const wildcard = HOST === '0.0.0.0' || HOST === '::';
    const lan: string[] = [];
    if (wildcard) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
        }
      }
      // Real home/office LAN addresses first (192.168.x.x, then 10.x, 172.16-31.x, then the rest).
      const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
      lan.sort((a, b) => rank(a) - rank(b));
    }
    console.log('[Pace IT Ledger] Running');
    console.log(`  Local:   ${scheme}://localhost:${PORT}`);
    if (wildcard) {
      for (const ip of lan) console.log(`  Network: ${scheme}://${ip}:${PORT}`);
    } else {
      console.log(`  Host:    ${scheme}://${HOST}:${PORT}`);
    }
  });
}

startServer().catch((err) => {
  console.error('[Pace IT Ledger] Failed to start server:', err);
  process.exit(1);
});
