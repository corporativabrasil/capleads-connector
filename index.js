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

let sock = null;
let conectado = false;
let pairingCode = null;
let iniciando = false;

// 📱 Número para pareamento (DDI + DDD + número)
const NUMERO_PAREAMENTO = "5511983905569";

// ======================================================
// 🔌 INICIAR WHATSAPP (APENAS PAIRING CODE)
// ======================================================
async function iniciarWhatsApp() {
  if (iniciando) return;
  iniciando = true;

  console.log("🚀 Iniciando WhatsApp Connector...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  sock = makeWASocket({
    auth: state,
    browser: ["CapLeads", "Chrome", "1.0"],
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  // ======================================================
  // 🔄 STATUS DE CONEXÃO
  // ======================================================
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      conectado = true;
      pairingCode = null;
      iniciando = false;
      console.log("✅ WhatsApp conectado com sucesso");
    }

    if (connection === "close") {
      conectado = false;
      iniciando = false;

      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Sessão encerrada. Apague auth_info e pareie novamente.");
        pairingCode = null;
      } else {
        console.log("⚠️ Conexão caiu.");
      }
    }
  });

  // ======================================================
  // 🔑 GERAR PAIRING CODE (UMA ÚNICA VEZ)
  // ======================================================
  if (!state.creds.registered) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      pairingCode = await sock.requestPairingCode(NUMERO_PAREAMENTO);
      console.log("🔑 Código de pareamento:", pairingCode);
      console.log("👉 WhatsApp > Aparelhos conectados > Conectar com código");
    } catch (e) {
      console.error("❌ Erro ao gerar pairing code:", e);
    }
  }

  // ======================================================
  // 📩 RECEBER MENSAGENS
  // ======================================================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!texto) return;

    const numero = msg.key.remoteJid.replace("@s.whatsapp.net", "");

    console.log("📩 Mensagem recebida:", numero, texto);

    try {
      await fetch("http://127.0.0.1:5000/whatsapp/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numero, mensagem: texto })
      });
    } catch (e) {
      console.error("❌ Erro ao enviar mensagem para o Flask:", e);
    }
  });
}

// ======================================================
// ▶️ START
// ======================================================
iniciarWhatsApp();

// ======================================================
// 📡 STATUS
// ======================================================
app.get("/status", (req, res) => {
  res.json({
    service: "capleads-whatsapp-connector",
    connected: conectado,
    pairing_disponivel: !!pairingCode
  });
});

// ======================================================
// 🔑 PAIRING CODE
// ======================================================
app.get("/pairing", (req, res) => {
  if (conectado) {
    return res.json({ status: "conectado" });
  }

  if (!pairingCode) {
    return res.status(404).json({
      status: "aguardando",
      mensagem: "Pairing code ainda não disponível"
    });
  }

  res.json({
    status: "pairing",
    code: pairingCode
  });
});

// ======================================================
// ✉️ ENVIAR MENSAGEM
// ======================================================
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

// ======================================================
app.listen(3005, () => {
  console.log("🚀 WhatsApp Connector rodando na porta 3005");
});

