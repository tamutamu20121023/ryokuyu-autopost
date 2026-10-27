const { loadEnv } = require("./env.mjs");
loadEnv();

const args = process.argv.slice(2);
const command = args[0] || "serve";

function main() {
  if (command === "schedule-run") {
    const { runDue } = require("./schedule.mjs");
    const dryRun = args.includes("--dry-run");
    runDue({ dryRun })
      .then((result) => {
        if (result.busy) {
          console.log("別のプロセスが予約を処理中です。スキップしました。");
          process.exit(0);
        }
        if (!result.processed.length) {
          console.log("実行対象の予約はありません。");
          process.exit(0);
        }
        for (const item of result.processed) {
          const title = item.job.title || item.job.type;
          if (!item.ok) console.error(`失敗: ${item.job.id} ${title} - ${item.error}`);
          else if (item.result?.skipped) console.log(`スキップ: ${item.job.id} ${title} - ${item.result.reason}`);
          else console.log(`公開: ${item.job.id} ${title} -> ${item.result?.url || ""}`);
        }
        process.exit(0);
      })
      .catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
    return;
  }

  // 既定: サーバーを起動してブラウザを開く
  const port = Number(process.env.PORT || 3000);
  const url = `http://localhost:${port}`;

  // すでにサーバーが動いていればブラウザだけ開く
  const net = require("node:net");
  const socket = new net.Socket();
  socket.setTimeout(500);
  socket.once("connect", () => {
    socket.destroy();
    openBrowser(url);
    process.exit(0);
  });
  socket.once("error", () => {
    socket.destroy();
    require("./server.mjs");
    waitForPort(port, () => {
      openBrowser(url);
    });
  });
  socket.connect(port, "127.0.0.1");
}

function waitForPort(port, cb) {
  const net = require("node:net");
  let attempts = 0;
  const timer = setInterval(() => {
    const s = new net.Socket();
    s.setTimeout(500);
    s.once("connect", () => {
      s.destroy();
      clearInterval(timer);
      cb();
    });
    s.once("error", () => {
      s.destroy();
      if (++attempts > 50) {
        clearInterval(timer);
        console.error("サーバーの起動に失敗しました。");
        process.exit(1);
      }
    });
    s.connect(port, "127.0.0.1");
  }, 200);
}

function openBrowser(url) {
  const { exec } = require("node:child_process");
  const fs = require("node:fs");
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      exec(`"${c}" --app="${url}" --window-size=1024,740`);
      return;
    }
  }
  if (process.platform === "win32") exec(`start "" "${url}"`);
  else if (process.platform === "darwin") exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

main();
