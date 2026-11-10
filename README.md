# Media Production engine (E10)

Part of the Public Accountability Machine. Creates, edits, renders and packages finished works — written works, still
images, music and audio programmes, animation and video, and interactive works — from editable, revisioned project
documents, with every render bound to exact inputs, rights, sources and tool versions.

The GitHub repository `Justice-For-All-Movement/Media-Production` was empty; this is its first implementation.

## Service layer

- Use: `import { createEngine, migrate, routes } from '@accountability/media-production/engine'` — see
  [`docs/ENGINE_API.md`](docs/ENGINE_API.md) for the full API, document formats, events, ports and status.
- Run: `npm run serve` with `DATABASE_URL`, `IDENTITY_PUBLIC_KEYS` (or `IDENTITY_JWKS_FILE`), `OBJECT_STORE_PATH`, and either
  `CONSENT_URL` + `CONSENT_TOKEN_FILE` or `PRODUCTION_STANDALONE=declared-rights`. The server also runs the render worker.
- System tools: `scripts/install-tools.sh` (ffmpeg, rsvg-convert, ImageMagick, exiftool, pandoc, LibreOffice, poppler,
  fluidsynth + GM SoundFont, espeak-ng, sox, fonts, zip).
- Test: `TEST_DATABASE_URL=postgresql://… npm run check` (real PostgreSQL and real tools; tests skip visibly without a
  database; the interactive test uses Playwright when it is installed).
- Pilot: `npm run pilot -- --out <dir>` with `TEST_DATABASE_URL` (disposable database) or `DATABASE_URL` produces a complete
  fictional production (the invented town of Larkmoor and its flood-relief fund) across all five pipelines, with manifests,
  project revisions and export bundles. Pilot artifacts are kept out of git.
