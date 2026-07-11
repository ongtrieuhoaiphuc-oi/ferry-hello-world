const http = require('node:http');

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f4f2ec">
  <title>Hello from Ferry</title>
  <style>
    :root {
      color-scheme: light;
      --paper: oklch(96% 0.012 82);
      --ink: oklch(24% 0.018 248);
      --muted: oklch(50% 0.018 248);
      --line: oklch(84% 0.016 82);
      --accent: oklch(59% 0.18 28);
      --accent-dark: oklch(48% 0.16 28);
      --success: oklch(55% 0.12 150);
      --error: oklch(55% 0.17 25);
      --shadow: 0 24px 70px oklch(35% 0.02 248 / 0.12);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-size: 16px;
      line-height: 1.5;
      font-optical-sizing: auto;
    }

    main {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      padding: 24px;
    }

    nav, footer {
      width: min(100%, 1120px);
      margin-inline: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: inherit;
      font-weight: 750;
      text-decoration: none;
      letter-spacing: -0.02em;
    }

    .mark {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      color: var(--paper);
      background: var(--accent);
      box-shadow: 0 6px 18px oklch(59% 0.18 28 / 0.22);
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 0.875rem;
      font-weight: 650;
    }

    .status::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 0 4px oklch(55% 0.12 150 / 0.12);
    }

    .hero {
      width: min(100%, 1120px);
      margin: auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 0.62fr);
      align-items: center;
      gap: clamp(48px, 8vw, 112px);
      padding-block: clamp(72px, 12vw, 144px);
    }

    .eyebrow {
      margin: 0 0 24px;
      color: var(--accent-dark);
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }

    h1 {
      max-width: 10ch;
      margin: 0 0 24px -0.04em;
      font-size: clamp(3.25rem, 9vw, 7.5rem);
      line-height: 0.9;
      letter-spacing: -0.075em;
      text-wrap: balance;
    }

    .lead {
      max-width: 56ch;
      margin: 0 0 32px;
      color: var(--muted);
      font-size: clamp(1rem, 1.8vw, 1.25rem);
      line-height: 1.6;
      text-wrap: pretty;
    }

    button {
      min-height: 48px;
      border: 0;
      border-radius: 999px;
      padding: 12px 22px;
      color: var(--paper);
      background: var(--ink);
      font: inherit;
      font-weight: 750;
      cursor: pointer;
      transition: transform 140ms cubic-bezier(0.25, 1, 0.5, 1), opacity 140ms cubic-bezier(0.25, 1, 0.5, 1);
    }

    button:hover { transform: translateY(-2px); }
    button:active { transform: translateY(0); }
    button:disabled { cursor: wait; opacity: 0.64; }
    button:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }

    .route {
      position: relative;
      min-height: 320px;
      display: grid;
      place-items: center;
    }

    .route::before {
      content: "";
      position: absolute;
      inset: 12% 0;
      border: 1px solid var(--line);
      border-radius: 50%;
      transform: rotate(-12deg);
    }

    .route::after {
      content: "";
      position: absolute;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent);
      transform: translate(112px, -84px);
      box-shadow: 0 0 0 12px oklch(59% 0.18 28 / 0.10);
    }

    .terminal {
      position: relative;
      z-index: 1;
      width: min(100%, 360px);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 24px;
      background: oklch(98% 0.008 82);
      box-shadow: var(--shadow);
      transform: rotate(2deg);
    }

    .terminal p { margin: 0; }
    .terminal .label {
      margin-bottom: 18px;
      color: var(--muted);
      font: 700 0.75rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .terminal code {
      display: block;
      overflow-wrap: anywhere;
      color: var(--ink);
      font: 650 0.95rem/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
      font-variant-ligatures: none;
    }

    .prompt { color: var(--accent-dark); }
    #reply { color: var(--success); }
    #reply.error { color: var(--error); }

    footer {
      padding-top: 24px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.875rem;
    }

    footer a { color: var(--ink); font-weight: 700; }

    @media (max-width: 760px) {
      main { padding: 20px; }
      .hero { grid-template-columns: 1fr; gap: 32px; padding-block: 72px; }
      .route { min-height: 260px; }
      .route::after { transform: translate(84px, -72px); }
      h1 { max-width: 8ch; }
      footer { align-items: flex-start; flex-direction: column; }
    }

    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <nav aria-label="Primary navigation">
      <a class="brand" href="/" aria-label="Ferry Hello World home">
        <span class="mark" aria-hidden="true">F</span>
        Ferry Hello
      </a>
      <span class="status">Service online</span>
    </nav>

    <section class="hero">
      <div>
        <p class="eyebrow">Node.js · Docker · Ferry</p>
        <h1>Hello, world.</h1>
        <p class="lead">A tiny app made for a big journey. It listens on Ferry's assigned port, ships in one container, and exposes a health check for smooth deploys.</p>
        <button id="ping" type="button">Ping the server</button>
      </div>

      <div class="route" aria-label="Live API response">
        <div class="terminal">
          <p class="label">Live route</p>
          <code><span class="prompt">GET</span> /api/hello</code>
          <code id="reply">{ "message": "Hello, world!" }</code>
        </div>
      </div>
    </section>

    <footer>
      <span>Built for zero-open-port deployment.</span>
      <a href="/health">Check health</a>
    </footer>
  </main>

  <script>
    const button = document.querySelector('#ping');
    const reply = document.querySelector('#reply');

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Pinging...';
      reply.classList.remove('error');
      reply.textContent = 'Waiting for response...';

      try {
        const response = await fetch('/api/hello');
        if (!response.ok) throw new Error('Request failed');
        const data = await response.json();
        reply.textContent = JSON.stringify(data);
        button.textContent = 'Server replied';
      } catch {
        reply.classList.add('error');
        reply.textContent = '{ "error": "Could not reach server" }';
        button.textContent = 'Try again';
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/hello') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: 'Hello, world!' }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) }));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, host, () => {
  console.log(`Ferry Hello World listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
