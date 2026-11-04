<h1 align="center">DevOps Playground</h1>

<p align="center">
  <a href="https://github.com/Nadjide/devops-playground/actions/workflows/ci.yml">
    <img src="https://github.com/Nadjide/devops-playground/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/Docker-containerized-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/GitHub_Actions-CI/CD-2088FF?logo=github-actions&logoColor=white" alt="GitHub Actions">
  <img src="https://img.shields.io/badge/Jest-tested-C21325?logo=jest&logoColor=white" alt="Jest">
</p>

A minimal but real DevOps showcase API built with Node.js, Express, Docker, Docker Compose and GitHub Actions.

This project is intentionally small. It focuses on a clean path from application code to automated tests, Docker image validation and runtime health checks.

## What this project demonstrates

- Containerized Node.js API
- Docker Compose local environment
- Automated API tests
- GitHub Actions CI pipeline
- Docker image build validation
- Runtime healthcheck

## Tech Stack

- Node.js 22
- Express
- Jest
- Supertest
- Docker
- Docker Compose
- GitHub Actions

## Project structure

```txt
devops-playground/
├── .github/
│   └── workflows/
│       └── ci.yml
├── src/
│   ├── app.js
│   └── server.js
├── tests/
│   └── app.test.js
├── .dockerignore
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── package-lock.json
└── README.md
```

## Run locally

Install dependencies:

```bash
npm ci
```

Run tests:

```bash
npm test
```

Start the API:

```bash
npm start
```

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

## Run with Docker

Build the image:

```bash
docker build -t devops-playground .
```

Run the container:

```bash
docker run -p 3000:3000 devops-playground
```

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

## Run with Docker Compose

Start the stack:

```bash
docker compose up --build
```

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

Stop the stack:

```bash
docker compose down
```

## API endpoints

### `GET /`

```json
{
  "message": "DevOps Playground API is running"
}
```

### `GET /health`

```json
{
  "status": "ok",
  "service": "devops-playground",
  "uptime": 12.345,
  "timestamp": "2026-06-12T10:00:00.000Z"
}
```

### `GET /version`

```json
{
  "name": "devops-playground",
  "version": "1.0.0",
  "environment": "development"
}
```

## CI/CD pipeline

The GitHub Actions workflow runs on pushes to `main`, pull requests targeting `main`, and manual dispatch.

The pipeline includes two jobs:

- `test`: installs dependencies with `npm ci` and runs the Jest/Supertest test suite.
- `docker`: validates the Docker Compose file, builds the Docker image, starts the Compose stack and checks `/health`.

## Playground development

The interactive workbench is being developed in independent feature lots.
The shared domain workspace provides validated contracts and deterministic
session state transitions. The React workbench opens directly in Demo mode
and runs entirely in the browser.

```bash
npm run dev:playground     # Vite dev server, prints its local URL
npm run build:playground   # static build in apps/web/dist
npm run lint
npm run test:playground    # domain and workbench unit tests
npm run test:e2e:demo      # Playwright demo suite against the static build
```

### Packaged playground

The packaged portal runs through Docker Compose and binds to
`http://127.0.0.1:3001` (set `PLAYGROUND_PORT` to change it).

```bash
npm run playground:demo     # portal only, browser simulation, no Docker socket
npm run playground:local    # portal plus the internal runner for real local Docker
npm run playground:status   # controller, runner, Docker, and owned lab resources
npm run playground:down     # end sessions, stop the stack, report owned leftovers
npm run playground:cleanup  # remove only resources owned by this installation
```

Local mode gives the runner access to the Docker socket, which controls the host
daemon; use it only on your own machine. The runner has no published port and
accepts only the controller's per-launch token.

See the [implementation plan](DEVOPS_PLAYGROUND_MASTER_PLAN.md) for the roadmap,
the [domain package](packages/lab-core/README.md) for its implemented API, and
the [workbench](apps/web/README.md) for the frontend structure.

## Why this project exists

This repository was created as a small but real DevOps showcase. It demonstrates how a simple application can be tested, containerized and validated through an automated CI pipeline.

It supports the positioning of Nadjide Omar as a Full Stack developer with a strong DevOps mindset: Full Stack Development · DevOps · CI/CD · Docker · API · Cloud · Architecture.
