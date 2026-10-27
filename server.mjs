import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const ROOT = import.meta.dirname;
const DATA = path.join(ROOT, "data", "transcriptions");
const CONFIG = path.join(ROOT, "data", "config", "settings.json");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 4520);

const WHISPER_MODEL =
  process.env.WHISPER_MODEL ?? path.join(ROOT, "models", "ggml-small-q5_1.bin");
const WHISPER_VAD_MODEL =
  process.env.WHISPER_VAD_MODEL ?? path.join(ROOT, "models", "ggml-silero-v5.1.2.bin");
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const AI_MODEL = "sonnet";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS = {
  maxRecordingMinutes: 90,
  transcriptionGlossary: "",
  transcriptionCorrections: [],
};

async function readSettings() {
  try {
    const raw = JSON.parse(await fsp.readFile(CONFIG, "utf8"));
    return {
      maxRecordingMinutes:
        Number.isInteger(raw.maxRecordingMinutes) && raw.maxRecordingMinutes > 0
          ? raw.maxRecordingMinutes
          : DEFAULT_SETTINGS.maxRecordingMinutes,
      transcriptionGlossary:
        typeof raw.transcriptionGlossary === "string" ? raw.transcriptionGlossary : "",
      useVad: raw.useVad === true,
      transcriptionCorrections: Array.isArray(raw.transcriptionCorrections)
        ? raw.transcriptionCorrections.filter(
            (p) => p && typeof p.from === "string" && typeof p.to === "string",
          )
        : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(next) {
  await fsp.mkdir(path.dirname(CONFIG), { recursive: true });
  await fsp.writeFile(CONFIG, JSON.stringify(next, null, 2), "utf8");
}

// ---------------------------------------------------------------- corrections

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyCorrections(text, pairs) {
  let result = text;
  for (const pair of pairs) {
    if (!pair.from.trim()) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(pair.from)}(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    result = result.replace(pattern, () => pair.to);
  }
  return result;
}

export function rollbackStatus(status, hasTranscript) {
  if (status === "transcribing") return hasTranscript ? "transcribed" : "recorded";
  return status;
}

// ---------------------------------------------------------------- storage

function slugify(input) {
  const base = (input || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "grabacion";
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (fs.existsSync(path.join(DATA, slug))) slug = `${base}-${n++}`;
  return slug;
}

function dir(slug) {
  return path.join(DATA, slug);
}

async function readMeta(slug) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir(slug), "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeMeta(slug, meta) {
  meta.updatedAt = new Date().toISOString();
  await fsp.writeFile(path.join(dir(slug), "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

async function listItems() {
  await fsp.mkdir(DATA, { recursive: true });
  const names = await fsp.readdir(DATA, { withFileTypes: true });
  const out = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !SLUG_RE.test(entry.name)) continue;
    const meta = await readMeta(entry.name);
    if (!meta) continue; // skip malformed, never crash the board
    meta.hasTranscript = fs.existsSync(path.join(dir(entry.name), "transcript.md"));
    out.push(meta);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

// ---------------------------------------------------------------- ffmpeg

function run(bin, args, { timeoutMs = 600_000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} superó el timeout de ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      reject(
        err.code === "ENOENT"
          ? new Error(`No se encontró "${bin}". Instalalo o seteá la env var correspondiente.`)
          : err,
      ),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} salió con código ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

/** WebM/Opus del browser -> WAV 16 kHz mono s16le, exactamente lo que whisper quiere. */
async function transcodeToWav(src, dest) {
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", src,
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    dest,
  ]);
}

async function probeDurationMs(file) {
  try {
    const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", file], { timeoutMs: 20_000 });
    return parseDuration(stderr);
  } catch (err) {
    return parseDuration(String(err.message));
  }
}

function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return (
    Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10
  );
}

/**
 * Transcribe con el filtro whisper que ya trae este build de ffmpeg
 * (--enable-whisper). No hace falta compilar whisper.cpp aparte.
 */
async function transcribeWav(wav, { durationMs = null, useVad = false } = {}) {
  if (!fs.existsSync(WHISPER_MODEL)) {
    throw new Error(
      `Falta el modelo de whisper en ${WHISPER_MODEL}. Seteá WHISPER_MODEL o esperá a que termine la descarga.`,
    );
  }
  const outJson = wav.replace(/\.wav$/, "") + ".json";

  // El parser de filtros de ffmpeg usa ":" como separador de opciones y se rompe
  // con drive letters (E:) y con espacios en la ruta ("translate meet").
  // Solución: correr con cwd = ROOT y pasar rutas RELATIVAS, que no tienen ninguno de los dos.
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

  const opts = [
    `model=${rel(WHISPER_MODEL)}`,
    "language=auto",
    "format=json",
    "queue=10",
    "use_gpu=false", // gfx1200 no está soportado por el backend; forzamos CPU y evitamos el fallback ruidoso
    `destination=${rel(outJson)}`,
  ];
  // VAD apagado por default: medido en esta máquina fue 2,3x MÁS LENTO sobre habla continua.
  // Puede ganar en reuniones con muchos silencios; se prende desde settings para poder comparar.
  if (useVad && fs.existsSync(WHISPER_VAD_MODEL)) opts.push(`vad_model=${rel(WHISPER_VAD_MODEL)}`);

  // Medido en esta máquina: ~2.8x realtime en CPU. Damos margen de 4x + 5 min de base.
  const audioSec = (durationMs ?? (await probeDurationMs(wav)) ?? 600_000) / 1000;
  const timeoutMs = Math.max(600_000, Math.ceil(audioSec * 4) * 1000 + 300_000);

  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", rel(wav),
    "-af", `whisper=${opts.join(":")}`,
    "-f", "null", "-",
  ], { timeoutMs, cwd: ROOT });

  const raw = await fsp.readFile(outJson, "utf8");
  return { segments: parseWhisperJson(raw), rawPath: outJson };
}

/** Devuelve el max_volume en dB. -91 o menos = silencio digital. */
async function detectSilence(file) {
  try {
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-nostdin", "-i", file, "-af", "volumedetect", "-f", "null", "-",
    ], { timeoutMs: 120_000 });
    const m = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function parseWhisperJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // el filtro puede emitir una secuencia de objetos, uno por línea
    parsed = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l.replace(/,$/, ""));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed.transcription ?? parsed.segments ?? []);
  return list
    .map((s) => ({
      start_ms: s.offsets?.from ?? s.start ?? 0,
      end_ms: s.offsets?.to ?? s.end ?? 0,
      text: String(s.text ?? "").trim(),
    }))
    .filter((s) => s.text);
}

// ---------------------------------------------------------------- AI

const SHARED_RULES = `- TRANSLATE the transcript to English if it is in another language. If it is already English, keep it.
- Fix spelling, punctuation, and obvious speech-to-text errors. Improve readability: paragraphs, and lists or headings where they genuinely help.
- PRESERVE the original meaning. Do NOT invent content, facts, or conclusions that were not said.
- Keep people's names, product names, URLs, and code exactly as written (transliterate names only if clearly garbled by the recognizer).
- Remove filler ("um", "uh", false starts) and merge fragmented sentences, but do not summarize away substance.`;

function buildPrompt(mode, body) {
  if (mode === "topics") {
    return `You clean up a raw speech-to-text transcript of a (possibly long) meeting and turn it into structured, navigable Markdown. Return ONLY a JSON object — no prose, no markdown code fences, nothing else.

Output shape:
{ "body": "<the structured markdown body>" }

Rules:
${SHARED_RULES}
- Begin the body with a "## Summary" section: 3–5 concise TL;DR bullets covering the whole meeting.
- After the summary, split the rest into chronological "## <short topic title>" sections, one per distinct subject discussed. Keep the original order of the conversation.
- Turn concrete action items, decisions, or next steps into GitHub-style checklist lines: "- [ ] action".
- This is a LONG transcript. Preserve ALL substance across the ENTIRE transcript — do NOT summarize away, shorten, or drop the later parts. Every topic from start to finish must appear.

Transcript to structure:
${body}`;
  }
  return `You clean up a raw speech-to-text transcript and turn it into tidy Markdown. Return ONLY a JSON object — no prose, no markdown code fences, nothing else.

Output shape:
{ "body": "<the cleaned-up markdown body>" }

Rules:
${SHARED_RULES}

Transcript to clean up:
${body}`;
}

function extractJson(text) {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first === -1 || last <= first) throw new Error("La IA no devolvió JSON parseable.");
    return JSON.parse(stripped.slice(first, last + 1));
  }
}

async function formatWithAI(body, mode) {
  const timeoutMs = Math.min(300_000, 120_000 + body.length);
  const prompt = buildPrompt(mode, body);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["-p", "--model", AI_MODEL, "--output-format", "json"], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("La IA superó el timeout."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      reject(
        err.code === "ENOENT"
          ? new Error("No se encontró el CLI `claude`. Instalá Claude Code o seteá CLAUDE_BIN.")
          : err,
      ),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude salió con código ${code}\n${stderr.slice(-2000)}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });

  const envelope = JSON.parse(out);
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`La IA devolvió un error: ${envelope.subtype ?? "desconocido"}`);
  }
  const result = extractJson(envelope.result);
  if (typeof result.body !== "string") throw new Error("La IA no devolvió el campo `body`.");
  return result.body;
}

// ---------------------------------------------------------------- http utils

function json(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
  res.end(buf);
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Range parser: bytes=a-b | bytes=a- | bytes=-suffix. null => full body. */
export function parseRange(header, size) {
  if (!header || !/^bytes=/.test(header)) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(",")) return null;
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start;
  let end;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

async function serveStatic(res, file) {
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function serveAudio(req, res, slug) {
  const wav = path.join(dir(slug), "audio.wav");
  const webm = path.join(dir(slug), "audio.webm");
  const file = fs.existsSync(wav) ? wav : webm;
  if (!fs.existsSync(file)) return res.writeHead(404).end("no audio");

  const { size } = await fsp.stat(file);
  const type = MIME[path.extname(file)];
  const range = parseRange(req.headers.range, size);

  if (range?.unsatisfiable) {
    return res
      .writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" })
      .end();
  }
  if (!range) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(206, {
    "content-type": type,
    "content-length": range.end - range.start + 1,
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
    "accept-ranges": "bytes",
  });
  fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveStatic(res, path.join(PUBLIC, "index.html"));
    }
    if (req.method === "GET" && p === "/app.js") {
      return serveStatic(res, path.join(PUBLIC, "app.js"));
    }
    if (req.method === "GET" && p === "/styles.css") {
      return serveStatic(res, path.join(PUBLIC, "styles.css"));
    }

    if (req.method === "GET" && p === "/api/settings") {
      return json(res, 200, await readSettings());
    }
    if (req.method === "PUT" && p === "/api/settings") {
      const patch = JSON.parse((await readBody(req)).toString("utf8"));
      const next = { ...(await readSettings()), ...patch };
      await writeSettings(next);
      return json(res, 200, next);
    }

    if (req.method === "GET" && p === "/api/items") {
      return json(res, 200, await listItems());
    }

    // subida de la grabación del browser
    if (req.method === "POST" && p === "/api/upload") {
      const title = (url.searchParams.get("title") || "").trim() || "Reunión sin título";
      const durationMs = Number(url.searchParams.get("durationMs")) || null;
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: "audio vacío" });

      const slug = await uniqueSlug(slugify(title));
      await fsp.mkdir(dir(slug), { recursive: true });
      const webm = path.join(dir(slug), "audio.webm");
      await fsp.writeFile(webm, buf);

      const meta = {
        id: randomUUID(),
        slug,
        title,
        status: "recorded",
        audioFile: "audio.webm",
        durationMs,
        language: null,
        transcribingStartedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeMeta(slug, meta);

      // transcodeo a WAV en segundo plano: el audio ya está a salvo en disco
      transcodeToWav(webm, path.join(dir(slug), "audio.wav"))
        .then(async () => {
          const m = await readMeta(slug);
          if (!m) return;
          m.audioFile = "audio.wav";
          if (!m.durationMs) m.durationMs = await probeDurationMs(path.join(dir(slug), "audio.wav"));
          m.maxVolumeDb = await detectSilence(path.join(dir(slug), "audio.wav"));
          await writeMeta(slug, m);
        })
        .catch((err) => console.error(`[${slug}] transcode falló:`, err.message));

      return json(res, 201, meta);
    }

    const itemMatch = /^\/api\/items\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (itemMatch) {
      const slug = decodeURIComponent(itemMatch[1]);
      const action = itemMatch[2];
      // slug safety ANTES de tocar el filesystem
      if (!SLUG_RE.test(slug)) return json(res, 400, { error: "slug inválido" });
      const meta = await readMeta(slug);
      if (!meta) return json(res, 404, { error: "no existe" });

      if (req.method === "GET" && action === "/audio") return serveAudio(req, res, slug);

      if (req.method === "GET" && !action) {
        let body = "";
        try {
          body = await fsp.readFile(path.join(dir(slug), "transcript.md"), "utf8");
        } catch {}
        return json(res, 200, { ...meta, body });
      }

      if (req.method === "DELETE" && !action) {
        await fsp.rm(dir(slug), { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }

      if (req.method === "PUT" && action === "/body") {
        const { body } = JSON.parse((await readBody(req)).toString("utf8"));
        await fsp.writeFile(path.join(dir(slug), "transcript.md"), String(body ?? ""), "utf8");
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && action === "/status") {
        const { status } = JSON.parse((await readBody(req)).toString("utf8"));
        if (!["recorded", "transcribed", "done"].includes(status)) {
          return json(res, 400, { error: "status inválido" });
        }
        meta.status = status;
        return json(res, 200, await writeMeta(slug, meta));
      }

      if (req.method === "POST" && action === "/transcribe") {
        const settings = await readSettings();
        const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const glossary = typeof payload.glossary === "string" ? payload.glossary : settings.transcriptionGlossary;

        const wav = path.join(dir(slug), "audio.wav");
        if (!fs.existsSync(wav)) {
          const webm = path.join(dir(slug), "audio.webm");
          if (!fs.existsSync(webm)) return json(res, 400, { error: "no hay audio" });
          await transcodeToWav(webm, wav);
        }

        meta.status = "transcribing";
        meta.transcribingStartedAt = new Date().toISOString();
        await writeMeta(slug, meta);

        try {
          const { segments } = await transcribeWav(wav, {
            durationMs: meta.durationMs,
            useVad: settings.useVad === true,
          });
          const text = applyCorrections(
            segments.map((s) => s.text).join("\n"),
            settings.transcriptionCorrections,
          );
          await fsp.writeFile(path.join(dir(slug), "transcript.md"), text, "utf8");
          const fresh = await readMeta(slug);
          fresh.status = "transcribed";
          fresh.transcribingStartedAt = null;
          await writeMeta(slug, fresh);
          return json(res, 200, { ...fresh, body: text });
        } catch (err) {
          const fresh = (await readMeta(slug)) ?? meta;
          const hasTranscript = fs.existsSync(path.join(dir(slug), "transcript.md"));
          fresh.status = rollbackStatus("transcribing", hasTranscript);
          fresh.transcribingStartedAt = null;
          await writeMeta(slug, fresh);
          return json(res, 500, { error: err.message });
        }
      }

      if (req.method === "POST" && action === "/format") {
        const { body, mode } = JSON.parse((await readBody(req)).toString("utf8"));
        if (!body?.trim()) return json(res, 400, { error: "transcripción vacía" });
        // propone, no persiste: el humano decide
        const formatted = await formatWithAI(body, mode === "topics" ? "topics" : "clean");
        return json(res, 200, { body: formatted });
      }
    }

    if (req.method === "POST" && p === "/api/corrections") {
      const { from, to } = JSON.parse((await readBody(req)).toString("utf8"));
      if (!from?.trim() || !to?.trim()) return json(res, 400, { error: "from/to requeridos" });
      const settings = await readSettings();
      const exists = settings.transcriptionCorrections.some(
        (c) => c.from.toLowerCase() === from.trim().toLowerCase(),
      );
      if (!exists) settings.transcriptionCorrections.push({ from: from.trim(), to: to.trim() });
      await writeSettings(settings);
      return json(res, 200, settings);
    }

    // Diagnóstico de ruteo: Chrome captura el endpoint de Console/Multimedia.
    // Si Comunicaciones apunta a otro, Teams reproduce donde Chrome NO escucha.
    if (req.method === "GET" && p === "/api/audio-endpoints") {
      try {
        const { stdout } = await run(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/audio-endpoints.ps1"],
          { timeoutMs: 30_000 },
        );
        const d = JSON.parse(stdout.trim());
        const short = (s) => String(s ?? "").replace(/\s*\(.*\)\s*$/, "").trim();
        const chromeHears = short(d.renderConsole);
        const commsGoesTo = short(d.renderComms);

        // ¿hay un dispositivo de mezcla capturable, y está prendido?
        let mixDevice = null;
        try {
          const { stdout: capOut } = await run(
            "powershell",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/list-endpoints.ps1"],
            { timeoutMs: 30_000 },
          );
          const caps = JSON.parse(capOut.trim());
          // Ranking: no todo "mix" sirve igual. El Stereo Mix de una placa que no
          // reproduce nada (acá Realtek, con el audio saliendo por el Arctis USB)
          // captura silencio, así que va último.
          const score = (n) => {
            if (/sonar.*stream/i.test(n)) return 100;   // mezcla completa de Sonar
            if (/voicemeeter|vb-?audio|cable output/i.test(n)) return 90;
            if (/stream mix|streaming/i.test(n)) return 80;
            if (/loopback|what u hear/i.test(n)) return 70;
            if (/stereo mix/i.test(n)) return 10;       // suele colgar de una placa sin uso
            return 0;
          };
          const found = (Array.isArray(caps) ? caps : [caps])
            .map((c) => ({ ...c, score: score(c.name) }))
            .filter((c) => c.score > 0)
            // primero los prendidos, después por calidad de la fuente
            .sort((a, b) =>
              (a.state === "ACTIVO" ? 0 : 1) - (b.state === "ACTIVO" ? 0 : 1) || b.score - a.score);

          if (found.length) {
            mixDevice = {
              name: short(found[0].name),
              enabled: found[0].state === "ACTIVO",
              alternatives: found.slice(1).map((c) => ({ name: short(c.name), state: c.state })),
            };
          }
        } catch {}

        return json(res, 200, {
          ...d,
          chromeHears,
          commsGoesTo,
          mismatch: chromeHears !== commsGoesTo,
          mixDevice,
        });
      } catch (err) {
        return json(res, 200, { error: err.message, mismatch: null });
      }
    }

    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, {
        model: WHISPER_MODEL,
        modelReady: fs.existsSync(WHISPER_MODEL),
        modelBytes: fs.existsSync(WHISPER_MODEL) ? fs.statSync(WHISPER_MODEL).size : 0,
      });
    }

    res.writeHead(404).end("not found");
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Grabador de reuniones  ->  http://localhost:${PORT}\n`);
  console.log(`  Modelo whisper: ${fs.existsSync(WHISPER_MODEL) ? "listo" : "descargando..."}`);
});
