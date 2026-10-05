#!/usr/bin/env node
/*
 * ffmpeg-bridge.js  v1.0
 * 本地 FFmpeg 桥接服务：让油猴脚本「视频下载助手」通过 localhost 调用你本机的 ffmpeg.exe。
 *
 * 用法（任选其一）：
 *   node ffmpeg-bridge.js
 *   node ffmpeg-bridge.js "C:\Program Files\Motrix\ffmpeg-motrix\ffmpeg.exe"
 * 或直接双击「启动FFmpeg桥接.bat」。
 *
 * 默认监听 127.0.0.1:16888
 *   GET  /status   返回 ffmpeg 路径与版本（供「实时检查」）
 *   POST /merge    下载音视频分片并合并到下载目录
 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.BDL_BRIDGE_PORT) || 16888;
const FFMPEG = process.argv[2] || [
  "C:\\Program Files\\Motrix\\ffmpeg-motrix\\ffmpeg.exe",
  path.join(process.env.APPDATA || "", "Motrix", "binaries", "ffmpeg.exe"),
  "ffmpeg",
].find((p) => fs.existsSync(p) || p === "ffmpeg");
const DL_DIR = process.env.BDL_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads", "视频下载助手");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bdl_bridge_"));
const DEF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36";

let version = null;
function probeVersion() {
  execFile(FFMPEG, ["-version"], { timeout: 8000 }, (e, out) => {
    const m = out ? /ffmpeg version\s+(\S+)/.exec(out) : null;
    version = m ? m[1] : "unknown";
  });
}
probeVersion();

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((res, rej) => {
    const cs = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n > 3e8) return rej(new Error("太大")); cs.push(c); });
    req.on("end", () => { try { res(JSON.parse(Buffer.concat(cs).toString("utf8") || "{}")); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
}

function dl(url, dest, referer) {
  return fetch(url, { redirect: "follow", headers: { "User-Agent": DEF_UA, ...(referer ? { Referer: referer } : {}) } })
    .then(async (r) => {
      if (!r.ok) throw new Error("下载失败 HTTP " + r.status);
      // Node 原生 fetch 的 body 是 Web ReadableStream（无 .pipe），需用 for-await 逐块写入
      await new Promise((res, rej) => {
        const ws = fs.createWriteStream(dest);
        ws.on("finish", res);
        ws.on("error", rej);
        (async () => {
          try {
            for await (const chunk of r.body) ws.write(chunk);
            ws.end();
          } catch (e) { rej(e); }
        })();
      });
    });
}

function ffmpeg(args) {
  return new Promise((res, rej) => {
    execFile(FFMPEG, args, { timeout: 3600e3, maxBuffer: 32 * 1024 * 1024 }, (e, so, se) =>
      e ? rej(new Error(se || e.message)) : res(so)
    );
  });
}

async function merge(body) {
  const sess = path.join(TMP, crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(sess, { recursive: true });
  fs.mkdirSync(DL_DIR, { recursive: true });

  const vIn = Array.isArray(body.video) ? body.video : [];
  const aIn = Array.isArray(body.audio) ? body.audio : [];

  // 1) 下载分片
  async function fetchParts(parts, prefix) {
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const ext = (p.ext || ((p.url.split("?")[0].match(/\.(\w+)$/) || [])[1] || "bin")).replace(/[^a-z0-9]/gi, "");
      const f = path.join(sess, prefix + "_" + i + "." + (ext || "bin"));
      await dl(p.url, f, p.referer || body.referer);
      files.push(f);
    }
    return files;
  }

  const vFiles = vIn.length ? await fetchParts(vIn, "v") : [];
  const aFiles = aIn.length ? await fetchParts(aIn, "a") : [];

  // 2) 拼接多段（单段则可直接合并）
  const concat = (files, name) => {
    const out = path.join(sess, name);
    if (files.length <= 1) return Promise.resolve(files[0]);
    const list = path.join(sess, name + ".list");
    fs.writeFileSync(list, files.map((f) => "file '" + f.replace(/\\/g, "/") + "'").join("\n"));
    return ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]).then(() => out);
  };

  const vFinal = vFiles.length ? await concat(vFiles, "v_out.mp4") : null;
  const aFinal = aFiles.length ? await concat(aFiles, "a_out.mp4") : null;

  // 3) 合并音视频（或直接封装视频）
  const safeTitle = String(body.title || "video").replace(/["\\|:*?<>/]/g, "_");
  const outFile = path.join(DL_DIR, safeTitle + "." + (body.format || "mp4"));
  const args = ["-y"];
  if (vFinal) args.push("-i", vFinal);
  if (aFinal) args.push("-i", aFinal);
  args.push("-c", "copy");
  if (vFinal && aFinal) args.push("-shortest");
  args.push("-movflags", "+faststart", outFile, "-loglevel", "error");
  if (!vFinal && !aFinal) throw new Error("缺少音视频输入");
  await ffmpeg(args);

  return { ok: true, out: outFile };
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const u = (req.url || "").split("?")[0];
  if (req.method === "GET" && u === "/status") {
    return send(res, 200, {
      ok: !!FFMPEG, mode: "local", ffmpeg: FFMPEG, version, downloadDir: DL_DIR,
      server: "ffmpeg-bridge v1.0", note: "本地桥接已就绪",
    });
  }
  if (req.method === "POST" && u === "/merge") {
    return readBody(req).then((b) => merge(b)).then((r) => send(res, 200, r))
      .catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  send(res, 404, { ok: false, error: "未知接口 " + u });
}).listen(PORT, HOST, () => {
  console.log("ffmpeg-bridge 已启动  http://" + HOST + ":" + PORT);
  console.log("ffmpeg      : " + FFMPEG);
  console.log("版本        : " + version);
  console.log("下载目录    : " + DL_DIR);
});

process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });