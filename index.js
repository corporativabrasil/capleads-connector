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

let sock;
let conectado = false;

// =====================================
// 🔌 INICIAR WHATSAPP (LOCAL / VPS)
// =====================================
async function iniciarWhatsApp() {
  console.log("🚀 Iniciando WhatsApp Connector (LOCAL)...");

  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info");

  sock = makeWASocket({
    auth: state,
    browser: ["CapLeads", "Chrome", "1.0"],
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      conectado = true;
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

  // =====================================
  // 📩 RECEBER MENSAGENS → CAPLEADS
  // =====================================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    const numero =
      msg.key.remoteJid.replace("@s.whatsapp.net", "");

    console.log("📩", numero, texto);

    await fetch("https://SEU-RAILWAY.app/whatsapp/receive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numero, mensagem: texto })
    });
  });
}

iniciarWhatsApp();

// =====================================
// 📡 STATUS
// =====================================
app.get("/status", (req, res) => {
  res.json({ connected: conectado });
});

// =====================================
// ✉️ ENVIAR MENSAGEM (CAPLEADS → WHATSAPP)
// =====================================
app.post("/send-message", async (req, res) => {
  const { numero, mensagem } = req.body;

  if (!conectado) {
    return res.status(400).json({ erro: "WhatsApp offline" });
  }

  await sock.sendMessage(
    `${numero}@s.whatsapp.net`,
    { text: mensagem }
  );

  res.json({ ok: true });
});

app.listen(3005, () =>
  console.log("🚀 Conector rodando em http://localhost:3005")
);

