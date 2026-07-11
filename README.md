# Ferry Hello World

A dependency-free Node.js Hello World app, packaged for deployment with [Ferry](https://github.com/gastonmorixe/ferry).

## What is included

- Responsive Hello World page
- `GET /api/hello` JSON endpoint
- `GET /health` health check
- Docker image running as a non-root user
- Dynamic `PORT` support and `0.0.0.0` binding for Dokku

## Run locally

```bash
npm start
```

Open <http://localhost:3000>.

## Run with Docker

```bash
docker build -t ferry-hello-world .
docker run --rm -p 3000:3000 ferry-hello-world
```

## Deploy with Ferry

After Ferry is installed and configured on your server:

```bash
ferry deploy ferry-hello-world \
  -r ongtrieuhoaiphuc-oi/ferry-hello-world \
  -H hello.example.com \
  -p 3000 \
  -y
```

Replace `hello.example.com` with a domain managed in your Cloudflare account. Ferry will clone this repository, build the Dockerfile, configure Dokku and Cloudflare Tunnel, then publish the app over HTTPS.
