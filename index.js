import express from "express"
import fetch from "node-fetch"
import qrcode from "qrcode"
import fs from "fs";
import path from "path";

import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys"

const app = express()
app.use(express.json())

let sock
let qrCode = null
let conectado = false

// controle anti-duplicação
const mensagensProcessadas = new Set()


/**
 * ==========================================
 * EXTRAI NÚMERO CORRETO DO WHATSAPP
 * ==========================================
 */
function extrairNumero(msg){

    if(msg.key?.participant){
        return msg.key.participant.split("@")[0]
    }

    if(msg.key?.participantPn){
        return msg.key.participantPn.split("@")[0]
    }

    if(msg.key?.senderPn){
        return msg.key.senderPn.split("@")[0]
    }

    if(msg.key?.remoteJid){

        const jid = msg.key.remoteJid

        if(jid.includes("@lid")) return null
        if(jid.includes("@broadcast")) return null
        if(jid.includes("status@broadcast")) return null

        return jid.split("@")[0]
    }

    return null
}


/**
 * ==========================================
 * EXTRAIR TEXTO DA MENSAGEM
 * ==========================================
 */
function extrairTexto(msg){

    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ""
    )
}



/**
 * ==========================================
 * INICIAR WHATSAPP
 * ==========================================
 */
async function iniciar() {

    const { state, saveCreds } =
        await useMultiFileAuthState("./auth_info")

    const { version } =
        await fetchLatestBaileysVersion()

    sock = makeWASocket({
        auth: state,
        version,
        browser: ["CapLeads", "Chrome", "1.0"]
    })

    sock.ev.on("creds.update", saveCreds)


    /**
     * ==========================================
     * STATUS DA CONEXÃO
     * ==========================================
     */
    sock.ev.on("connection.update", async (update) => {

        const { connection, qr, lastDisconnect } = update

        if (qr) {

            qrCode = await qrcode.toDataURL(qr)

            console.log("📱 QR Code gerado")

            conectado = false
        }

        if (connection === "open") {

            console.log("✅ WhatsApp conectado")

            conectado = true
            qrCode = null
        }

        if (connection === "close") {

            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut

            console.log("⚠️ Conexão fechada")

            if (shouldReconnect) {
                iniciar()
            }
        }

    })


    /**
     * ==========================================
     * EVENTO MENSAGEM RECEBIDA
     * ==========================================
     */
    sock.ev.on("messages.upsert", async ({ messages, type }) => {

        // evita duplicação do Baileys (append/notify)
        if(type !== "notify") return

        const msg = messages?.[0]

        if (!msg) return
        if (!msg.message) return

        // ignora mensagens enviadas pelo próprio sistema
        if (msg.key?.fromMe) return

        const id = msg.key?.id

        // evita duplicação
        if(mensagensProcessadas.has(id)) return
        mensagensProcessadas.add(id)

        // controle memória
        if(mensagensProcessadas.size > 5000){
            mensagensProcessadas.clear()
        }

        const numero = extrairNumero(msg)

        if(!numero){
            console.log("⚠️ Mensagem ignorada (lid/broadcast)")
            return
        }

        const texto = extrairTexto(msg)

        if(!texto) return

        console.log("📩 Mensagem recebida")
        console.log("Numero:", numero)
        console.log("Texto:", texto)


        /**
         * ==========================================
         * WEBHOOK → CAPLEADS
         * ==========================================
         */
        try {

            await fetch(
                "https://www.capleads.com.br/whatsapp/receive",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        numero,
                        mensagem: texto
                    })
                }
            )

            console.log("✅ Webhook enviado para CapLeads")

        } catch (e) {

            console.log("❌ Erro webhook:", e)

        }

    })

}

iniciar()



/**
 * ==========================================
 * STATUS WHATSAPP
 * ==========================================
 */
app.get("/status", (req,res)=>{

    res.json({
        connected: conectado
    })

})


/**
 * ==========================================
 * QR CODE
 * ==========================================
 */
app.get("/qr", (req,res)=>{

    res.json({
        qr: qrCode,
        connected: conectado
    })

})


/**
 * ==========================================
 * ENVIAR MENSAGEM
 * ==========================================
 */
app.post("/send", async (req,res)=>{

    const {numero, mensagem} = req.body

    try {

        await sock.sendMessage(
            numero + "@s.whatsapp.net",
            {text: mensagem}
        )

        res.json({status:"ok"})

    } catch(e){

        console.log("❌ Erro envio:", e)

        res.json({status:"erro"})

    }

})

/**
 * ==========================================
 * LOGOUT / DESCONECTAR
 * ==========================================
 */
app.post("/logout", async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }

        qrCode = null;
        conectado = false;

        const authPath = path.resolve("auth_info");

        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        // reinicia para gerar novo QR
        setTimeout(() => {
            iniciar();
        }, 1500);

        res.json({
            ok: true,
            message: "WhatsApp desconectado com sucesso"
        });

    } catch (e) {
        console.log("❌ Erro logout:", e);

        res.status(500).json({
            ok: false,
            erro: String(e)
        });
    }
});


/**
 * ==========================================
 * START SERVER
 * ==========================================
 */

const PORT = process.env.PORT || 3005

app.listen(PORT, ()=>{

    console.log("🚀 Connector WhatsApp rodando na porta", PORT)

})


