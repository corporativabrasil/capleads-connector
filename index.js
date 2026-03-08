import express from "express"
import fetch from "node-fetch"
import qrcode from "qrcode"
import fs from "fs"
import path from "path"

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

// controle anti duplicação
const mensagensProcessadas = new Set()


/**
 * ==========================================
 * EXTRAI NÚMERO DO WHATSAPP
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
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.title ||
        msg.message?.templateButtonReplyMessage?.selectedId ||
        ""
    )
}



/**
 * ==========================================
 * INICIAR WHATSAPP
 * ==========================================
 */
async function iniciar(){

    const { state, saveCreds } =
        await useMultiFileAuthState("./data/auth_info")

    const { version } =
        await fetchLatestBaileysVersion()

    sock = makeWASocket({
        auth: state,
        version,
        browser: ["CapLeads","Chrome","1.0"]
    })

    sock.ev.on("creds.update", saveCreds)


    /**
     * ==========================================
     * STATUS DA CONEXÃO
     * ==========================================
     */
    sock.ev.on("connection.update", async (update)=>{

        const { connection, qr, lastDisconnect } = update

        if(qr){

            qrCode = await qrcode.toDataURL(qr)

            console.log("📱 QR Code gerado")

            conectado = false
        }

        if(connection === "open"){

            console.log("✅ WhatsApp conectado")

            conectado = true
            qrCode = null
        }

        if(connection === "close"){

            console.log("⚠️ Conexão fechada")

            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut

            if(shouldReconnect){
                iniciar()
            }

        }

    })


    /**
     * ==========================================
     * CLIENTE DIGITANDO
     * ==========================================
     */
    sock.ev.on("presence.update", async (data)=>{

        const jid = Object.keys(data.presences || {})[0]

        if(!jid) return

        const presence = data.presences[jid]

        if(!presence) return

        const status = presence.lastKnownPresence

        if(status === "composing"){

            const numero = jid.split("@")[0]

            try{

                await fetch(
                    "https://www.capleads.com.br/whatsapp/digitando",
                    {
                        method:"POST",
                        headers:{
                            "Content-Type":"application/json"
                        },
                        body:JSON.stringify({
                            numero
                        })
                    }
                )

            }catch(e){

                console.log("Erro digitando:",e)

            }

        }

    })


    /**
     * ==========================================
     * MENSAGEM RECEBIDA
     * ==========================================
     */
    sock.ev.on("messages.upsert", async ({ messages, type }) => {

        if(type !== "notify" && type !== "append") return

        const msg = messages?.[0]

        if(!msg) return
        if(msg.key?.fromMe) return


        const messageContent =
            msg.message?.ephemeralMessage?.message ||
            msg.message

        if(!messageContent) return


        const id = msg.key?.id

        if(id && mensagensProcessadas.has(id)) return

        if(id) mensagensProcessadas.add(id)

        if(mensagensProcessadas.size > 5000){
            mensagensProcessadas.clear()
        }


        const numero = extrairNumero(msg)

        if(!numero){

            console.log("⚠️ Mensagem ignorada (lid/broadcast)")

            return
        }


        const texto = extrairTexto({ message: messageContent })

        if(!texto){

            console.log("⚠️ Mensagem sem texto")

            return
        }


        console.log("📩 Mensagem recebida")
        console.log("Numero:", numero)
        console.log("Texto:", texto)


        /**
         * ==========================================
         * WEBHOOK → CAPLEADS
         * ==========================================
         */
        try{

            console.log("📡 Enviando webhook para CapLeads...")

            const r = await fetch(
                "https://www.capleads.com.br/whatsapp/receive",
                {
                    method:"POST",
                    headers:{
                        "Content-Type":"application/json"
                    },
                    body:JSON.stringify({
                        numero,
                        mensagem:texto,
                        origem:"cliente"
                    })
                }
            )

            if(!r.ok){

                const erro = await r.text()

                console.log("❌ Backend respondeu erro:", erro)

            }else{

                console.log("✅ Webhook enviado para CapLeads")

            }

        }catch(e){

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
app.get("/status",(req,res)=>{

    res.json({
        connected: conectado
    })

})


/**
 * ==========================================
 * QR CODE
 * ==========================================
 */
app.get("/qr",(req,res)=>{

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

    const { numero, mensagem } = req.body

    if(!numero || !mensagem){

        return res.status(400).json({
            status:"erro"
        })

    }

    try{

        await sock.sendMessage(
            numero + "@s.whatsapp.net",
            { text: mensagem }
        )

        res.json({ status:"ok" })

    }catch(e){

        console.log("❌ Erro envio:", e)

        res.status(500).json({
            status:"erro"
        })

    }

})



/**
 * ==========================================
 * LOGOUT / DESCONECTAR
 * ==========================================
 */
app.post("/logout", async (req,res)=>{

    try{

        if(sock){
            await sock.logout()
        }

        qrCode = null
        conectado = false

        const authPath = path.resolve("./data/auth_info")

        if(fs.existsSync(authPath)){
            fs.rmSync(authPath,{recursive:true,force:true})
        }

        setTimeout(()=>{

            iniciar()

        },1500)

        res.json({
            ok:true,
            message:"WhatsApp desconectado"
        })

    }catch(e){

        console.log("❌ Erro logout:",e)

        res.status(500).json({
            ok:false,
            erro:String(e)
        })

    }

})



/**
 * ==========================================
 * START SERVER
 * ==========================================
 */
const PORT = process.env.PORT || 3005

app.listen(PORT, ()=>{

    console.log("🚀 Connector WhatsApp rodando na porta",PORT)

})
