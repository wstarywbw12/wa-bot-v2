const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const path = require("path");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = 8000;

/* ================= DATABASE ================= */
const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "wa_db",
  waitForConnections: true,
  connectionLimit: 10,
});

/* ================= GLOBAL STATE ================= */
let client = null;
let isReady = false;
let waState = "INIT";
let waInfo = null;
let lastQr = null;
let isInitializing = false;

/* ================= HELPER ================= */
function isClientReady() {
  return (
    client &&
    client.info &&
    client.info.wid &&
    client.pupPage &&
    isReady
  );
}

function emitStatus() {
  io.emit("status", {
    state: waState,
    ready: isReady,
  });
}

/* ================= CREATE CLIENT ================= */
async function createClient() {
  if (isInitializing || client) return;
  isInitializing = true;

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "node-wa",
      dataPath: "./.wwebjs_auth",
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
    webVersionCache: { type: "none" },
  });

  registerWaEvents();
  await client.initialize();

  isInitializing = false;
}

/* ================= WA EVENTS (ONCE) ================= */
function registerWaEvents() {
  client.on("qr", (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      if (err) return;
      lastQr = url;
      waState = "QR";
      emitStatus();
      io.emit("qr", url);
    });
  });

  client.on("authenticated", () => {
    waState = "AUTHENTICATED";
    emitStatus();
  });

  client.on("ready", () => {
    isReady = true;
    lastQr = null;
    waState = "READY";

    const info = client.info || {};
    waInfo = {
      number: info?.wid?.user || "-",
      name: info?.pushname || "Unknown",
      platform: info?.platform || "-",
    };

    emitStatus();
    io.emit("info", waInfo);

    console.log("✅ WhatsApp READY:", waInfo);
  });

  client.on("disconnected", async (reason) => {
    console.log("❌ WA Disconnected:", reason);

    isReady = false;
    waState = "RECONNECTING";
    emitStatus();

    try {
      await client.destroy();
    } catch {}

    client = null;

    setTimeout(() => createClient(), 4000);
  });
}

/* ================= EXPRESS ================= */
app.use(express.json());
app.use(express.static(path.join(__dirname, "client")));

app.get("/", (_, res) =>
  res.sendFile(path.join(__dirname, "client/index.html")),
);

/* ================= SOCKET ================= */
io.on("connection", async (socket) => {
  socket.emit("status", { state: waState, ready: isReady });

  if (waInfo) socket.emit("info", waInfo);
  if (lastQr) socket.emit("qr", lastQr);

  const [rows] = await db.query(`
    SELECT id, phone, message, status, error_message, created_at
    FROM wa_message_logs
    ORDER BY id DESC
    LIMIT 50
  `);

  socket.emit(
    "history:init",
    rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      message: r.message,
      status: r.status,
      error_message: r.error_message,
      time: new Date(r.created_at).toLocaleString("id-ID"),
    })),
  );

  socket.on("wa:disconnect", async () => {
    if (!client) return;

    waState = "DISCONNECTING";
    emitStatus();

    await client.destroy();
    client = null;

    isReady = false;
    waState = "DISCONNECTED";
    emitStatus();
  });

  socket.on("wa:reconnect", () => {
    if (client) return;
    waState = "RECONNECTING";
    emitStatus();
    createClient();
  });
});

/* ================= API SEND MESSAGE ================= */
app.post("/send-message", async (req, res) => {
  const { number, message } = req.body;

  if (!number || !message) {
    return res.json({ error: true, message: "Number & message wajib" });
  }

  let status = "SENT";
  let errorMessage = null;

  try {
    if (!isClientReady()) {
      throw new Error("WhatsApp belum siap / reconnecting");
    }

    const chatId = number.includes("@c.us")
      ? number
      : number.replace(/\D/g, "") + "@c.us";

    await client.sendMessage(chatId, message);
  } catch (e) {
    status = "FAILED";
    errorMessage = e.message;
  }

  /* SIMPAN KE DB (SELALU) */
  const [result] = await db.execute(
    `INSERT INTO wa_message_logs (phone, message, status, error_message)
     VALUES (?, ?, ?, ?)`,
    [number, message, status, errorMessage],
  );

  const historyItem = {
    id: result.insertId,
    phone: number,
    message,
    status,
    error_message: errorMessage,
    time: new Date().toLocaleString("id-ID"),
  };

  io.emit("history:update", historyItem);

  return res.json({
    error: status === "FAILED",
    status,
    message: status === "SENT" ? "Pesan terkirim" : errorMessage,
  });
});

/* ================= START ================= */
server.listen(PORT, () => {
  console.log(`🚀 Node WA running: http://localhost:${PORT}`);
  createClient();
});

/* ================= SAFETY ================= */
process.on("unhandledRejection", (e) =>
  console.error("Unhandled:", e.message),
);
