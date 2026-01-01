import express from "express";
import cors from "cors";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

// =====================================================
// 🌍 ENV
// =====================================================
const PORT = process.env.PORT || 3005;
const BACKEND_URL = process.env.BACKEND_URL; // ex: https://www.capleads.com.br

// =====================================================
// 🔧 ESTADO GLOBAL
// =====================================================
let sock;
let conectado = false;
let ultimoQR = null;

// =====================================================
// 🔌 INICIAR WHATSAPP
// =====================================================
async function iniciarWhatsApp() {
  console.log("🚀 Iniciando WhatsApp Connector...");

  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info");

  sock = makeWASocket({
    auth: state,
    browser: ["CapLeads", "Chrome", "1.0"],
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      ultimoQR = qr;
      console.log("📲 Novo QR Code gerado");
    }

    if (connection === "open") {
      conectado = true;
      ultimoQR = null;
      console.log("✅ WhatsApp conectado com sucesso");
    }

    if (connection === "close") {
      conectado = false;

      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Sessão encerrada. Apague auth_info e gere novo QR.");
      } else {
        console.log("⚠️ Conexão caiu. Tentando reconectar...");
        setTimeout(iniciarWhatsApp, 3000);
      }
    }
  });

  // =====================================================
  // 📩 RECEBER MENSAGENS → BACKEND CAPLEADS
  // =====================================================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    const numero =
      msg.key.remoteJid.replace("@s.whatsapp.net", "");

    console.log("📩", numero, texto);

    if (!BACKEND_URL) return;

    try {
      await fetch(`${BACKEND_URL}/whatsapp/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          numero,
          mensagem: texto,
          origem: "cliente"
        })
      });
    } catch (e) {
      console.error("❌ Erro ao enviar mensagem para o backend:", e.message);
    }
  });
}

iniciarWhatsApp();

// =====================================================
// 📡 STATUS
// =====================================================
app.get("/status", (req, res) => {
  res.json({ connected: conectado });
});

// =====================================================
// 📷 QR CODE
// =====================================================
app.get("/qr", (req, res) => {
  if (!ultimoQR) {
    return res.status(404).json({ error: "QR indisponível" });
  }

  res.json({
    qr: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(ultimoQR)}`
  });
});

// =====================================================
// ✉️ ENVIAR MENSAGEM (BACKEND → WHATSAPP)
// =====================================================
app.post("/send", async (req, res) => {
  const { numero, mensagem } = req.body;

  if (!conectado) {
    return res.status(400).json({ error: "WhatsApp offline" });
  }

  try {
    await sock.sendMessage(
      `${numero}@s.whatsapp.net`,
      { text: mensagem }
    );

    res.json({ status: "ok" });

  } catch (e) {
    console.error("❌ Erro ao enviar mensagem:", e.message);
    res.status(500).json({ error: "Falha ao enviar mensagem" });
  }
});

// =====================================================
// 🚀 START
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Conector rodando na porta ${PORT}`);
});


// =====================================
// 🏠 ROOT / HEALTH CHECK
// =====================================
app.get("/", (req, res) => {
  res.json({
    service: "CapLeads WhatsApp Connector",
    status: "online",
    connected: conectado,
    has_qr: !!ultimoQR,
    uptime: process.uptime()
  });
});
