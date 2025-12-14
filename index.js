// =====================================================
// 📦 IMPORTS (APENAS UMA VEZ)
// =====================================================
import express from "express";
import cors from "cors";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import fetch from "node-fetch";

// =====================================================
// 🚀 APP EXPRESS
// =====================================================
const app = express();
app.use(cors());
app.use(express.json());

// =====================================================
// 🌐 ESTADO GLOBAL
// =====================================================
let sock = null;
let conectado = false;
let iniciando = false;

// =====================================================
// 🔌 INICIAR WHATSAPP (QR — ÚNICO MODO ESTÁVEL NO RAILWAY)
// =====================================================
async function iniciarWhatsApp() {
  if (iniciando) return;
  iniciando = true;

  console.log("🚀 Iniciando WhatsApp Connector...");

  // ⚠️ ESTE CAMINHO PRECISA SER O MESMO DO VOLUME NO RAILWAY
  const { state, saveCreds } =
    await useMultiFileAuthState("/app/auth_info");

  sock = makeWASocket({
    auth: state,
    browser: ["CapLeads", "Chrome", "1.0"],
    printQRInTerminal: true, // 👈 ESSENCIAL NO RAILWAY
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  // =====================================================
  // 🔄 STATUS DE CONEXÃO
  // =====================================================
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      conectado = true;
      iniciando = false;
      console.log("✅ WhatsApp conectado com sucesso");
    }

    if (connection === "close") {
      conectado = false;
      iniciando = false;

      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Sessão expirada. Novo QR será necessário.");
      } else {
        console.log("⚠️ Conexão caiu. Railway irá reiniciar.");
      }
    }
  });

  // =====================================================
  // 📩 RECEBER MENSAGENS
  // =====================================================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!texto) return;

    const numero =
      msg.key.remoteJid.replace("@s.whatsapp.net", "");

    console.log("📩 Mensagem recebida:", numero, texto);

    try {
      await fetch("http://127.0.0.1:5000/whatsapp/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numero, mensagem: texto })
      });
    } catch (e) {
      console.error("❌ Erro ao enviar para Flask:", e);
    }
  });
}

// =====================================================
// ▶️ START
// =====================================================
iniciarWhatsApp();

// =====================================================
// 📡 STATUS
// =====================================================
app.get("/status", (req, res) => {
  res.json({
    service: "capleads-whatsapp-connector",
    connected: conectado
  });
});

// =====================================================
// ✉️ ENVIAR MENSAGEM
// =====================================================
app.post("/send-message", async (req, res) => {
  const { numero, mensagem } = req.body;

  if (!conectado || !sock) {
    return res.status(400).json({
      status: "erro",
      mensagem: "WhatsApp não conectado"
    });
  }

  try {
    await sock.sendMessage(
      `${numero}@s.whatsapp.net`,
      { text: mensagem }
    );
    res.json({ status: "ok" });
  } catch (e) {
    console.error("❌ Erro ao enviar mensagem:", e);
    res.status(500).json({ status: "erro" });
  }
});

// =====================================================
// 🌐 LISTEN
// =====================================================
app.listen(3005, () => {
  console.log("🚀 WhatsApp Connector rodando na porta 3005");
});



