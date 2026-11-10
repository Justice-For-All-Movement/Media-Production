# E10 — Media Production engine: service API

Repository `Justice-For-All-Movement/Media-Production`, package `@accountability/media-production`.
Schema `e10_production`, capability prefix `production`. Kit: `src/service-kit.ts` version 1.0.1
(sha256 `95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5`), `src/contracts.ts` from the Identity engine.

The engine produces finished works from editable, revisioned project documents through five pipelines that share one
service layer: projects and revisions, an asset library, render jobs, immutable renders with manifests, exports, a consent
gate, an optional budget reservation and stale/blocked propagation.

## 1. Entry points

```ts
import { createEngine, migrate, routes, manifest, SCHEMA, migrations, PIPELINES } from '@accountability/media-production/engine';
import { httpUseDecisionPort } from '@accountability/media-production/serve';

createEngine({
  sql,                       // kit Sql (pgSql(pool))
  objects?,                  // kit ObjectStore — required for assets, renders and exports (calls fail `unavailable` without it)
  ports?: {
    useDecisions?: UseDecisionPort,   // E11 decide(); asked before every render ('adapt') and export ('reproduce')
    budget?: BudgetPort,              // E13; reserve per render (category 'render_compute', unit 'compute_second') and per provider call
    authorization?: AuthorizationPort // E01; re-checked in the worker before rendering and before approve/export/spend
  },
  config?: {
    workRoot?: string,                                  // render workspaces (default OS temp dir)
    standalone?: { useDecisions?: 'declared-rights' },  // ONLY way to render without a UseDecisionPort (see §5)
    requireApprovedAssetsForExport?: boolean,           // default true
    maxAssetBytes?: number,                             // default 512 MiB
    providers?: ProviderConfig                          // optional generation providers (§7)
  }
}): ProductionEngine
```

Server: `npm run serve` (`src/engine/serve.ts`, export `./serve`) runs migrations, serves HTTP and runs the render worker loop.
Env: `DATABASE_URL`, `PORT` (8110), `HOST` (127.0.0.1), `IDENTITY_PUBLIC_KEYS` (JSON kid→PEM) or `IDENTITY_JWKS_FILE`,
`IDENTITY_ISSUER`, `OBJECT_STORE` (`fs`|`s3`), `OBJECT_STORE_PATH`, `S3_*`, `PRODUCTION_WORK_ROOT`, `PRODUCTION_WORKER=off`
(API only), `PRODUCTION_STANDALONE=declared-rights`, `CONSENT_URL` + `CONSENT_TOKEN_FILE` (HTTP UseDecisionPort to E11
`POST /v1/use-decisions`), `PRODUCTION_{IMAGE,TTS,MUSIC,SINGING}_PROVIDER_URL` + `_KEY_FILE` (+ `_MODEL`), `E10_SOUNDFONT`.

Job runner (hosts that do not use `serve`): `engine.runJobs({ worker?: string, limit?: number }): Promise<number>` — one pass
of the kit job loop for kind `production.render`; call it repeatedly. Renders are kit jobs (lease 60 s with heartbeats,
`maxAttempts` 2).

Pilot: `npm run pilot -- --out <dir> [--quick]` with `DATABASE_URL` (used as is) or `TEST_DATABASE_URL` (disposable DB).
Writes every render, manifest, project revision, export bundle, `pilot-report.json` and `README.txt` (§9).

## 2. Capabilities

| Capability | Methods |
|---|---|
| `production:read` | get/list projects, revisions, diff, validate, assets, asset bytes, renders, manifests, outputs, exports (metadata), preview, providers, inspect, search |
| `production:write` | createProject(FromEditorial), updateProjectLinks, saveRevision, applyOperations, restoreRevision, importAsset, addAssetVersion, setAssetRights, importRenderOutput |
| `production:render` | requestRender, cancelRender, runQc |
| `production:approve` (sensitive) | setAssetApproval |
| `production:export` (sensitive) | createExport, getExportBytes |
| `production:spend` (sensitive) | generateAsset (with `production:write`) |
| `production:events` (sensitive) | events, applyUpstreamChange |
| `production:audit` | audit |

`production:*` never grants the sensitive ones. Every method checks scope (tenant + project) and compartments; foreign or
hidden objects are `not_found`, also in lists, search, inspect, job lookups and HTTP (404).

## 3. Service methods (`ProductionEngine`, all take `ctx: ServiceContext` first)

```ts
createProject(ctx, { kind: 'written'|'image'|'audio'|'video'|'interactive', title, doc?, editorialRef?, sources?, compartment?, idempotencyKey? }): Promise<Project>
createProjectFromEditorial(ctx, { kind, editorial /* E09 exportDocument() result as returned */, title?, options?, compartment?, idempotencyKey? }): Promise<Project>
getProject(ctx, productionId): Promise<Project>
listProjects(ctx, { kind?, limit? }?): Promise<Project[]>
updateProjectLinks(ctx, { productionId, editorialRef?, sources?, resolveStale? }): Promise<Project>       // re-link to a corrected editorial revision
saveRevision(ctx, { productionId, doc, baseRevision?, summary?, idempotencyKey? }): Promise<RevisionInfo>   // whole document
applyOperations(ctx, { productionId, operations: Doc[], baseRevision?, summary?, idempotencyKey? }): Promise<RevisionInfo>
getRevision(ctx, productionId, revision?): Promise<Revision>               // reopen any saved revision (doc included)
listRevisions(ctx, productionId): Promise<RevisionInfo[]>
diffRevisions(ctx, productionId, from, to): Promise<{ from, to, entries: DiffEntry[], summary }>
restoreRevision(ctx, { productionId, revision, idempotencyKey? }): Promise<RevisionInfo>   // restore-as-new
validateProject(ctx, productionId, revision?): Promise<{ ok, problems: { level, message, at? }[] }>
importAsset(ctx, { name, filename, bytes, rights, provenance?, sources?, compartment?, idempotencyKey? }): Promise<Asset>
addAssetVersion(ctx, { assetId, ...same }): Promise<Asset>
setAssetRights(ctx, { assetId, rights, note? }): Promise<Asset>             // new version, same bytes; clears a block
setAssetApproval(ctx, { assetId, approval: 'approved'|'rejected'|'pending', note? }): Promise<Asset>
importRenderOutput(ctx, { renderId, output, name?, idempotencyKey? }): Promise<Asset>   // e.g. song render → music bed for a film
generateAsset(ctx, { provider: 'image'|'tts'|'music'|'singing', name, params, sources?, idempotencyKey? }): Promise<Asset>
getAsset(ctx, assetId): Promise<Asset>;  listAssets(ctx, { class?, limit? }?): Promise<Asset[]>
getAssetBytes(ctx, assetId, version?): Promise<FileResult>
requestRender(ctx, { productionId, revision?, profile?: 'preview'|'final' (default final), options?, idempotencyKey? }): Promise<Render>
getRender(ctx, renderId): Promise<Render>;  listRenders(ctx, { productionId?, limit? }?): Promise<Render[]>
cancelRender(ctx, renderId): Promise<Render>                               // kills the running subprocess
getRenderManifest(ctx, renderId): Promise<Json>
getRenderOutput(ctx, renderId, name): Promise<FileResult>                  // also 'manifest.json'
runQc(ctx, renderId): Promise<{ ok, checks }>
createExport(ctx, { renderId, format?: 'bundle', audience?, destination?, idempotencyKey? }): Promise<Export>
getExport(ctx, exportId): Promise<Export>;  listExports(ctx, { renderId? }?): Promise<Export[]>;  getExportBytes(ctx, exportId): Promise<FileResult>
previewInteractive(ctx, productionId, revision?): Promise<string>          // one self-contained HTML page
providers(ctx): Promise<Json>                                              // configured/verification status per provider
runJobs({ worker?, limit? }?): Promise<number>
// StandardEngine: inspect, search, audit, events, applyUpstreamChange, health
```

Types: `Rights = { kind: 'permission', ref: uref(E11), attribution?, restrictions? } | { kind: 'license', license, attribution, url? } | { kind: 'generated', license, attribution }`.
`Provenance = { sourceRefs: uref[], tool?, toolVersion?, params?, parentAssets?: uref[], provider?, note?, synthetic? }`.
`Render.state`: `queued | running | done | failed | cancelled | blocked`; `progress` 0..1 and `stage` come from real tool
output (ffmpeg `-progress`) and pipeline stages. Refs: `E10:project:<id>@<rev>`, `E10:asset:<id>@<version>`,
`E10:render:<id>`, `E10:export:<id>`.

Generic edit operations for every kind (`applyOperations`): `{ op: 'set'|'remove'|'insert'|'move', path, value?, to? }` with a
JSON pointer; array segments may be an index, `-` or `id=<id>` (e.g. `/chapters/id=c1/blocks/id=b1/text`).

## 4. Pipelines (document shape · kind-specific operations · outputs)

**written** — `{ title, subtitle, authors, language, notice?, credits, layout: { pageSize A4|Letter|A5|B5, margins mm, bodyFont, headingFont (DejaVu/Noto), fontSizePt, lineHeight, titlePage, toc, notes: footnotes|endnotes, sourceCompanion, copyright }, sourceNotes: { uref: label }, chapters: [{ id, title, blocks: [{ id, type: heading|paragraph|quote|list|verse|image|pagebreak, text, basis?, disclosure?, attribution?, sources? }] }] }`.
Ops: `addChapter, insertBlock, updateBlock, removeBlock, moveBlock, setLayout`. Final: HTML (print CSS, inlined images),
DOCX and EPUB3 (pandoc), PDF (pandoc DOCX with a generated reference document carrying page size/margins/fonts →
LibreOffice `writer_pdf_Export`), page-1 thumbnail. Notes are generated from block source urefs; a source companion lists
every source and where it is used; disclosed blocks print a labelled disclosure before the passage and on a disclosures page.
Preview: HTML only. QC: `pdftotext` finds title and each disclosure; `unzip -t` on DOCX/EPUB.

**image** — `{ title, canvas: { width, height, background }, layers: [...], generated: [{ group, generator, params }], export: { formats png|jpeg|webp|svg, jpegQuality, webpQuality }, sources, basis?, disclosure?, alt? }`.
Layers: `image` (assetId[/assetVersion/page for PDFs], crop in source pixels, fit cover|contain|stretch, scale, rotate, opacity, filters grayscale/sepia/blur/brightness/contrast/saturate), `text` (font, size, colour, align, bold/italic, wrap with real glyph metrics, maxLines, letterSpacing, background), `shape` (rect/ellipse/line/polygon/path, fill/stroke/gradient), `gradient`, `redaction` (always opaque).
Ops: `addLayer, updateLayer, removeLayer, reorderLayer, setCanvas, generate` (generators `timeline`, `quoteCard`,
`locationCard`, `documentExcerpt` — crops a region of an evidence asset with highlight and redactions — `coverArt`,
deterministic from project content; re-running a group replaces it). Rendering: SVG scene graph → `rsvg-convert` →
ImageMagick; metadata stripped with exiftool; SVG export flattens everything up to the top-most redaction into pixels so
covered content is not recoverable. Disclosed images get a labelled strip rendered into the pixels. Preview: 480 px PNG.

**audio / song** — `{ mode: 'song', title, seed, tempo, key: { tonic, mode major|minor|dorian|mixolydian }, timeSignature, mood hopeful|somber|driving|calm, sections: [{ id, type intro|verse|pre_chorus|chorus|refrain|hook|bridge|outro|spoken|instrumental, label, bars, chords (one per bar), lyrics: string[], basis?, disclosure?, sources? }], tracks: [{ id, role lead|harmony|bass|drums|extra, name, program (GM), volume, pan, mute, solo, notes: [{ id, section, start (beats), dur, pitch, vel, syl?, stress? }] }], mix: { loudness LUFS, reverb, fadeIn, fadeOut, compression, lowCut, highShelf }, guide: { enabled, style sung|spoken, voice, gain } }`.
Ops: `compose` (generator: syllabified lyrics with stress → scale-aware melodic contour, notes per syllable, cadences at
phrase ends, seeded chorus motif repeated with a final-chorus variation, voice-led triads, bass with approach notes, drum
patterns with fills; deterministic from `seed`), `transpose` (whole song or one track; drums never), `setInstrument`,
`setTrack` (volume/pan/mute/solo), `addTrack`, `removeTrack`, `addNote`, `editNote`/`moveNote`, `deleteNote`,
`reorderSections`, `moveSection`, `removeSection`, `duplicateSection`, `regenerateSection` (optionally per role, with a
seed), `setLyrics`, `setChords`, `setTempo`, `setKey`, `setMix`, `setGuide`.
Final: Standard MIDI File (format 1, tempo/time/key signature, section markers, lyric events), per-track stems
(fluidsynth + FluidR3_GM, FLAC), synthetic guide vocal stem, mix (ffmpeg: gain, constant-power pan, high-pass, shelf,
`aecho` reverb, compressor, fades) and two-pass `loudnorm` → WAV, FLAC, MP3, OGG, lyric sheet (chords, disclosures).
**Guide vocal is synthetic**: style `sung` speaks each syllable with espeak-ng, estimates its pitch, shifts it to the melody
note (octave-folded) and time-fits it with sox — a pitched guide, not a singing performance; `spoken` time-fits whole
phrases. Labelled synthetic in metadata, manifest `generated` and credits. Preview: first N s (default 45) MP3.

**audio / programme** — `{ mode: 'program', title, clips: [{ id, track narration|music|clip, source: { type: 'tts', text, voice, speed } | { type: 'asset', assetId }, start | follow (seconds after the previous voice clip), trimStart, duration?, gain dB, fadeIn, fadeOut, basis?, disclosure?, sources? }], ducking: { enabled, threshold, ratio, attack, release }, mix: { loudness, lowCut, fadeIn, fadeOut } }`.
Ops: `addClip, updateClip, removeClip, setDucking, setMix`. Music is ducked under voice with `sidechaincompress`; disclosures
are also spoken as an end note. Outputs WAV/FLAC/MP3/OGG + transcript.

**video** — `{ title, width, height, fps, scenes: [{ id, title, duration, visual: { type: 'image', assetId, kenBurns: { from, to: { x, y, zoom } } } | { type: 'video', assetId, trimStart } | { type: 'title', title, subtitle, background } | { type: 'scene', scene: { background, layers (keyframed) } } | { type: 'color' }, overlays: [lowerThird|text (fade/slide/typewriter)|layer], transition: { type cut|crossfade|fade, duration }, narration?: { type: 'tts', text, voice } | { type: 'asset', assetId }, captions: [{ start, end, text }], basis?, disclosure?, sources? }], audio: [{ id, role music|clip, assetId, start, trimStart, duration?, gain, fadeIn, fadeOut, loop }], ducking, captions: { burnIn, auto }, credits: { enabled, lines, seconds }, disclosureCardSeconds, loudness }`.
Ops: `addScene, updateScene, removeScene, moveScene, addOverlay, removeOverlay, setNarration, addAudio, updateAudio, removeAudio`.
Rendering: scenes are fitted to their narration; generated visuals and overlays are drawn frame by frame from the same SVG
scene graph (identical frames hard-linked); images use ffmpeg `zoompan`; each segment is encoded separately and cached by
content hash (unchanged scenes are reused on re-render); segments joined with `xfade`/concat; captions (auto from
narration + authored + disclosure cues) burned in with libass and written as SRT and WebVTT; reconstruction/invention scenes
get a mandatory disclosure card before them and an on-screen basis label during them; a credits roll is generated from the
render's inputs, disclosures and synthetic-voice notice. Final: H.264/AAC MP4, VP9/Opus WebM, poster + 3 thumbnails,
SRT, VTT. Preview: 240p, ≤12 fps MP4 + SRT.

**interactive** — `{ title, language, intro, notice?, start, variables: { name: scalar }, nodes: [{ id, title, text, media: [{ assetId, alt, caption }], choices: [{ id, label, target, condition?: { var, op eq|ne|gt|lt|gte|lte|set|unset, value? }, set?: { var: value } }], ending?, basis?, disclosure?, sources?, sourceNote?, attribution? }], sourceNotes, credits }`.
Ops: `addNode, updateNode, removeNode, addChoice, updateChoice, removeChoice, addMedia, setStart, setVariable`.
`validateProject` reports missing start, unknown targets, dead ends, endings with choices, unreachable nodes, no reachable
ending, undeclared variables, empty nodes; errors stop a final render. Outputs: ZIP (`index.html`, `sources.html`,
`assets/`, README; no network references; CSP; keyboard play with Tab/Enter and number keys; focus moves to each passage;
live region; noscript fallback with linked sections; progress saved in guarded localStorage) and a single-file HTML.
Preview: `previewInteractive` / `GET /v1/production/projects/:id/preview`.

**From E09** (`createProjectFromEditorial`, `editorial` = `{ manifest, document, renderings }` exactly as E09
`exportDocument` returns): the project's `editorialRef` is `manifest.document` (`E09:document:<id>@<rev>`), sources are the
export's sources. Blocks with a disclosed basis (reconstruction, invention, satire, …) without disclosure text are refused.
written ← any document (passage headings → chapters, scenes/script/lyrics/story nodes mapped); image ← cover art from the
document, or a quote card with `options.blockId`; audio ← `lyric_section` blocks are composed into a song (key/tempo from
the block data or `options`), otherwise a narrated programme; video ← `scene` panels become clips (duration, panel asset
refs bound through `options.assets: { '<uref without revision>': assetId }`, otherwise a marked storyboard placeholder),
narration/dialogue become synthetic speech (dialogue also a lower third), on-screen text an overlay; interactive ← `story_node`
blocks (keys, start, choices, conditions, effects → variables, endings).

## 5. Consent gate, approvals, budget

Before queuing **and again in the worker before rendering**, the engine asks `UseDecisionPort.decide` with action `adapt`:
one request per input asset (subjects: asset version ref, its E11 permission ref, its source refs) and one for the project
sources. `deny` (or a blocked/rejected asset) makes the render `blocked` with the reasons in `error`; `review` blocks final
renders but allows previews. Decisions are recorded on the render and in its manifest. Exports ask again with action
`reproduce` (passing `audience`/`destination`), require every input asset to be approved, and refuse stale or blocked renders
(`stale`, `consent_denied`). A port error is a deny. **Without a port every render is blocked** unless
`config.standalone.useDecisions === 'declared-rights'`, which accepts declared rights and records each decision as
`by: 'standalone-declared-rights'` "not verified by a consent engine". With a `BudgetPort`, `requestRender` reserves the
estimated compute seconds (`budget_exhausted` → HTTP 402, nothing queued), commits actual seconds on success and releases
on failure/cancel.

## 6. Manifests, renders, exports

A render is bound to one project revision and exact asset versions. Its manifest (`production.manifest/v1`, stored as
`manifest.json` next to the outputs and in the database, with `manifestDigest`): render, project (ref, revision, document
digest, editorialRef), `inputs` (asset version ref, sha256, size, media type, rights, provenance, sources, approval),
`sources` (editorial revision, project and block sources, asset sources and permission refs), `tools` with probed versions,
`parameters`, `disclosures` (basis, text, where it appears), `credits`, `generated` (synthetic speech, stems, frames …),
`decisions`, `outputs` (name, media type, size, sha256, role, probe info), `details` (QC, timeline, loudness). Older renders
are never changed or deleted. The export bundle (`application/zip`) holds the outputs, `manifest.json`, `export.json`
(export decisions), `CREDITS.txt` and a `<file>.provenance.json` sidecar per primary output. `runQc` re-reads stored bytes,
compares digests and re-probes. Object keys: `<tenant>/<project>/{assets,renders,exports,cache}/…`.

## 7. Provider adapters (implemented, not verified against a live provider)

`config.providers.{image,tts,music,singing} = { baseUrl, apiKey, model?, voice?, license?, name? }`, plus `timeoutMs`,
`pollIntervalMs`, `maxBytes`. image: OpenAI-images-compatible `POST /images/generations` (b64 or same-origin URL);
tts: OpenAI-speech-compatible `POST /audio/speech`; music/singing: `POST /generations` returning audio or `{ id, status }`
polled at `GET /generations/{id}` until `audio_base64`/`audio_url`. Result links on another origin are refused; redirects are
refused; the key never appears in errors, assets, manifests or audit. Not configured → `unavailable`. Tested only against a
controlled local HTTP server. Generated assets are marked `synthetic` with rights `generated`.

## 8. Events and upstream changes

Emitted (`subject`): `production.project_created` (project), `production.revision_saved` (project@rev),
`production.asset_created`, `production.asset_version_added`, `production.asset_approval_changed` (asset@version),
`production.render_requested`, `production.render_completed` (payload productionId, revision, profile, kind,
manifestDigest, seq), `production.render_failed`, `production.render_cancelled`, `production.render_blocked`,
`production.render_stale`, `production.qc_failed` (render), `production.project_stale|blocked` (project@head),
`production.asset_stale|blocked` (asset), `production.export_created|stale|blocked` (export). Stale/blocked payloads:
`{ reason, cause: eventId, changeKind, … }`. Downstream E12 should treat `render_stale`/`render_blocked` as `render_changed`.

`applyUpstreamChange(ctx, { eventId, kind, refs, reason })` (idempotent by eventId, per tenant/project): finds assets whose
version ref, permission ref, sources or provenance match; projects whose editorial ref, declared sources, current-revision
block sources or assets match; renders whose manifest sources or inputs match (and queued/running renders of affected
projects); and those renders' exports. `permission_withdrawn` and `source_removed` mark them **blocked** (bytes retained but
no longer served; new renders using a blocked asset are blocked); every other kind marks them **stale** (still readable,
not exportable). `content_changed` on an E09 document at a revision ≤ the one a project is pinned to does not affect it.
Nothing is deleted or rewritten. `updateProjectLinks({ resolveStale: true })` re-links a project; `setAssetRights` records new
rights as a new asset version and lifts the asset block (earlier renders stay blocked).

## 9. HTTP

Standard: `GET /healthz`, `GET /v1/manifest`, `GET /v1/inspect?ref=`, `GET /v1/search?q=`, `GET /v1/audit`, `GET /v1/events`,
`POST /v1/upstream-changes`. Own routes (bearer token; JSON bodies; asset bytes as `bytesBase64`):
`POST /v1/production/projects` · `POST /v1/production/projects/from-editorial` · `GET /v1/production/projects[?kind]` ·
`GET /v1/production/projects/:id` · `PATCH …/:id/links` · `GET|POST …/:id/revisions` · `GET …/:id/revisions/:rev|head` ·
`POST …/:id/operations` · `GET …/:id/diff?from&to` · `POST …/:id/restore` · `GET …/:id/validate` · `GET …/:id/preview` (HTML, CSP) ·
`POST /v1/production/:id/qc` (render id) · `POST /v1/assets` · `GET /v1/assets` · `POST /v1/assets/generate` · `GET /v1/assets/:id` ·
`POST /v1/assets/:id/versions` · `GET /v1/assets/:id/bytes[?version]` · `POST /v1/assets/:id/rights` · `POST /v1/assets/:id/approval` ·
`POST /v1/renders` (202) · `GET /v1/renders[?productionId]` · `GET /v1/renders/:id` · `POST /v1/renders/:id/cancel` ·
`GET /v1/renders/:id/manifest` · `GET /v1/renders/:id/outputs/:name` · `POST /v1/renders/:id/qc` · `POST /v1/renders/:id/to-asset` ·
`POST /v1/exports` · `GET /v1/exports[?renderId]` · `GET /v1/exports/:id` · `GET /v1/exports/:id/bytes` · `GET /v1/production/providers`.
Errors: kit mapping plus `unavailable`/`provider_unavailable` 503, `tool_failed` 500 with code, `cancelled` 409,
`consent_denied` 403, `budget_exhausted` 402, `stale` 409, `approval_invalid` 409.

## 10. Tools (system packages; `scripts/install-tools.sh`)

ffmpeg/ffprobe (libx264, libvpx-vp9, libopus, libvorbis, libmp3lame, libass, `loudnorm`, `sidechaincompress`, `xfade`,
`zoompan`), rsvg-convert, ImageMagick (`convert`, `identify`), exiftool, pandoc, LibreOffice (`soffice`), poppler
(`pdftoppm`, `pdfinfo`, `pdftotext`), fluidsynth + FluidR3_GM SoundFont, espeak-ng, sox, zip/unzip, fontconfig with DejaVu
and Noto fonts. Tests also use tesseract, python3 + numpy and Playwright (Chromium). Every tool's version is probed and
recorded in manifests; a missing one yields `unavailable` naming it.

## 11. Status

Implemented and locally tested on real PostgreSQL 16 and the real tools above (`tests/engine-*.test.ts`, 16 tests):
all five pipelines create → edit → render → verify (pdftotext/pdfinfo/pdffonts, identify + pixel checks + OCR, ffprobe,
EBU R128 loudness, numpy pitch analysis of stems before/after transpose, OCR of burned-in captions and disclosure cards,
Playwright keyboard play-through of the exported ZIP) → revise → re-render with old versions retained → reopen revisions;
import from real E09 exports (fixture generated by the E09 engine's own `exportDocument`); consent deny/review/withdrawal
after request; standalone mode; stale/blocked propagation; cancellation killing subprocesses; budget reservation and
exhaustion; tenant/project/compartment isolation; fail-closed authorization; idempotent replay; QC tamper detection;
provider adapters against a local server; HTTP end to end. The pilot (`npm run pilot`) ran end to end (18 renders).

Not implemented / not verified:
- Generation providers: implemented, **not verified against any live provider**; no credentials were available.
- Sung guide vocal is pitch-shifted synthetic speech, not singing synthesis; musical quality of generated arrangements is
  rule-based, not judged by people.
- Video assets as visuals are supported (trim, scale/crop) but not exercised in tests; no per-clip speed changes, no
  colour grading, no audio-from-video-asset passthrough.
- No GPU pools, no isolated render sandbox beyond subprocess argument arrays, timeouts, output caps and a fresh temp
  directory per render; LibreOffice and pandoc run with the engine's privileges.
- The HTTP `httpUseDecisionPort` in `serve.ts` uses one static service token (not per-request scoped); under PAM the host
  should pass an in-process or per-tenant port.
- No pixel-identical reproduction is promised across tool versions; manifests record versions and parameters.
- Performance was not load-tested; the per-scene video cache is per tenant/project and never evicted.
- Not deployed to a hosted environment. No independent security review.
