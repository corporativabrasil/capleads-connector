import express from "express"
import fetch from "node-fetch"
import qrcode from "qrcode"
import fs from "fs"
import path from "path"
import { Boom } from "@hapi/boom"

import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} from "@whiskeysockets/baileys"

const app = express()
app.use(express.json())

/*
==========================================
ARMAZENA SESSÕES POR EMPRESA
==========================================
*/

const sessoes = {}

const mensagensProcessadas = new Set()

/*
==========================================
EXTRAIR NUMERO WHATSAPP
==========================================
*/

function extrairNumero(msg){

    if(msg.key?.participant)
        return msg.key.participant.split("@")[0]

    if(msg.key?.participantPn)
        return msg.key.participantPn.split("@")[0]

    if(msg.key?.senderPn)
        return msg.key.senderPn.split("@")[0]

    if(msg.key?.remoteJid){

        const jid = msg.key.remoteJid

        if(jid.includes("@broadcast")) return null
        if(jid.includes("status@broadcast")) return null
        if(jid.includes("@lid")) return null

        return jid.split("@")[0]
    }

    return null
}

/*
==========================================
EXTRAIR TEXTO
==========================================
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


/*
==========================================
CRIAR SESSÃO WHATSAPP
==========================================
*/

async function iniciarSessao(empresa_id){

    if(sessoes[empresa_id]){
        console.log("Sessão já existe:",empresa_id)
        return
    }

    console.log("Iniciando sessão empresa",empresa_id)

    const pasta = "./data/session_" + empresa_id

    const { state, saveCreds } =
        await useMultiFileAuthState(pasta)

    const { version } =
        await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        auth: state,
        version,
        browser:["CapLeads","Chrome","1.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000
    })
    
    sessoes[empresa_id] = {
        sock,
        qr:null,
        conectado:false
    }

    sock.ev.on("creds.update",saveCreds)

        /*
    /*
    ==========================================
    STATUS DA CONEXÃO
    ==========================================
    */
    
    sock.ev.on("connection.update", async (update)=>{
    
        const { connection, qr, lastDisconnect } = update
    
        /*
        ==========================================
        QR CODE GERADO
        ==========================================
        */
    
        if(qr){
    
            try{
    
                sessoes[empresa_id].qr = await qrcode.toDataURL(qr)
                sessoes[empresa_id].conectado = false
    
                console.log("📱 QR gerado empresa",empresa_id)
    
            }catch(e){
    
                console.log("Erro gerar QR:",e)
    
            }
    
        }
    
        /*
        ==========================================
        CONEXÃO ABERTA
        ==========================================
        */
    
        if(connection === "open"){
    
            sessoes[empresa_id].qr = null
            sessoes[empresa_id].conectado = true
    
            console.log("✅ WhatsApp conectado empresa",empresa_id)
    
        }
    
        /*
        ==========================================
        CONEXÃO FECHADA
        ==========================================
        */
    
        if(connection === "close"){
    
            const statusCode =
                new Boom(lastDisconnect?.error)?.output?.statusCode
    
            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut
    
            console.log("⚠️ Conexão fechada empresa",empresa_id)
            console.log("Motivo:",statusCode)
    
            if(shouldReconnect){
    
                console.log("🔄 Reconectando empresa",empresa_id)
    
                setTimeout(()=>{
    
                    iniciarSessao(empresa_id)
    
                },3000)
    
            }else{
    
                console.log("🚪 Sessão encerrada empresa",empresa_id)
    
                delete sessoes[empresa_id]
    
            }
    
        }
    
    })


    /*
    ==========================================
    CLIENTE DIGITANDO
    ==========================================
    */

    sock.ev.on("presence.update", async (data)=>{

        const jid = Object.keys(data.presences || {})[0]

        if(!jid) return

        const presence = data.presences[jid]

        if(!presence) return

        if(presence.lastKnownPresence==="composing"){

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
                            empresa_id,
                            numero
                        })
                    }
                )

            }catch(e){

                console.log("Erro digitando:",e)

            }

        }

    })


    /*
    ==========================================
    MENSAGENS RECEBIDAS
    ==========================================
    */

    sock.ev.on("messages.upsert", async ({messages,type})=>{

        if(type!=="notify") return

        const msg = messages?.[0]

        if(!msg) return
        if(msg.key?.fromMe) return

        const content =
            msg.message?.ephemeralMessage?.message ||
            msg.message

        if(!content) return

        const id = msg.key?.id

        if(id && mensagensProcessadas.has(id)) return

        if(id) mensagensProcessadas.add(id)

        if(mensagensProcessadas.size>5000)
            mensagensProcessadas.clear()

        const numero = extrairNumero(msg)

        if(!numero) return

        const texto =
            extrairTexto({message:content})

        if(!texto) return

        console.log("Mensagem empresa",empresa_id)
        console.log(numero,texto)

        try{

            await fetch(
                "https://www.capleads.com.br/whatsapp/receive",
                {
                    method:"POST",
                    headers:{
                        "Content-Type":"application/json"
                    },
                    body:JSON.stringify({
                        empresa_id,
                        numero,
                        mensagem:texto,
                        origem:"cliente"
                    })
                }
            )

        }catch(e){

            console.log("Erro webhook:",e)

        }

    })

}

/*
==========================================
INICIAR SESSÃO (CONNECT)
==========================================
*/

app.post("/connect", async (req,res)=>{

    const {empresa_id} = req.body

    if(!empresa_id){
        return res.status(400).json({
            erro:"empresa_id obrigatório"
        })
    }

    try{

        if(!sessoes[empresa_id]){
            await iniciarSessao(empresa_id)
        }

        res.json({
            status:"iniciando"
        })

    }catch(e){

        console.log("Erro iniciar sessão:",e)

        res.status(500).json({
            erro:"erro iniciar sessão"
        })

    }

})

/*
==========================================
CONNECT VIA GET (PARA TESTE NO NAVEGADOR)
==========================================
*/

app.get("/connect", async (req,res)=>{

    const empresa_id = req.query.empresa_id

    if(!empresa_id){
        return res.json({
            erro:"empresa_id obrigatório"
        })
    }

    try{

        if(!sessoes[empresa_id]){
            await iniciarSessao(empresa_id)
        }

        res.json({
            status:"iniciando sessão",
            empresa_id
        })

    }catch(e){

        console.log("Erro iniciar sessão:",e)

        res.json({
            erro:"erro iniciar sessão"
        })

    }

})

/*
==========================================
QR CODE DA EMPRESA
==========================================
*/

app.get("/qr",(req,res)=>{

    const empresa_id = req.query.empresa_id

    if(!empresa_id){
        return res.json({
            qr:null
        })
    }

    const sessao = sessoes[empresa_id]

    if(!sessao){
        return res.json({
            qr:null
        })
    }

    res.json({
        qr:sessao.qr,
        connected:sessao.conectado
    })

})



/*
==========================================
STATUS WHATSAPP
==========================================
*/

app.get("/status",(req,res)=>{

    const empresa_id = req.query.empresa_id

    if(!empresa_id){
        return res.json({
            connected:false
        })
    }

    const sessao = sessoes[empresa_id]

    if(!sessao){
        return res.json({
            connected:false
        })
    }

    res.json({
        connected:sessao.conectado
    })

})



/*
==========================================
ENVIAR MENSAGEM
==========================================
*/

app.post("/send", async (req,res)=>{

    const {empresa_id,numero,mensagem} = req.body

    if(!empresa_id || !numero || !mensagem){

        return res.status(400).json({
            erro:"dados inválidos"
        })

    }

    const sessao = sessoes[empresa_id]

    if(!sessao){

        return res.status(400).json({
            erro:"sessão não encontrada"
        })

    }

    try{

        await sessao.sock.sendMessage(
            numero+"@s.whatsapp.net",
            {text:mensagem}
        )

        res.json({
            status:"ok"
        })

    }catch(e){

        console.log("Erro envio:",e)

        res.status(500).json({
            erro:"erro envio"
        })

    }

})



/*
==========================================
LOGOUT / DESCONECTAR EMPRESA
==========================================
*/

app.post("/logout", async (req,res)=>{

    const {empresa_id} = req.body

    if(!empresa_id){

        return res.status(400).json({
            erro:"empresa_id obrigatório"
        })

    }

    try{

        const sessao = sessoes[empresa_id]

        if(sessao && sessao.sock){

            await sessao.sock.logout()

        }

        const authPath =
            path.resolve("./data/session_"+empresa_id)

        if(fs.existsSync(authPath)){

            fs.rmSync(authPath,{
                recursive:true,
                force:true
            })

        }

        delete sessoes[empresa_id]

        res.json({
            ok:true
        })

    }catch(e){

        console.log("Erro logout:",e)

        res.status(500).json({
            erro:"erro logout"
        })

    }

})



/*
==========================================
AUTO RECONECTAR SESSÕES AO INICIAR
==========================================
*/

function restaurarSessoes(){

    const pasta = "./data"

    if(!fs.existsSync(pasta)){
        fs.mkdirSync(pasta,{recursive:true})
        console.log("📁 pasta data criada")
        return
    }

    if(!fs.existsSync(pasta)) return

    const dirs = fs.readdirSync(pasta)

    dirs.forEach((dir)=>{

        if(dir.startsWith("session_")){

            const empresa_id =
                dir.replace("session_","")

            console.log(
                "Restaurando sessão empresa",
                empresa_id
            )

            iniciarSessao(empresa_id)

        }

    })

}



/*
==========================================
START SERVER
==========================================
*/

const PORT = process.env.PORT

app.listen(PORT,()=>{

    console.log("🚀 Connector WhatsApp rodando porta",PORT)

    restaurarSessoes()

})





