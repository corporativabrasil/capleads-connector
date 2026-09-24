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
app.use(express.json({ limit: "8mb" }))

/*
==========================================
CONFIGURAÇÃO
==========================================
*/

const PORT = process.env.PORT || 3005

const CAPLEADS_BASE_URL = (
    process.env.CAPLEADS_BASE_URL ||
    "https://www.capleads.com.br"
).replace(/\/+$/, "")

const DATA_DIR = path.resolve(
    process.env.WHATSAPP_DATA_DIR || "./data"
)

/*
==========================================
ARMAZENA SESSÕES POR EMPRESA
==========================================
*/

const sessoes = {}
const mensagensProcessadas = new Set()

/*
==========================================
HELPERS DE SESSÃO
==========================================
*/

function normalizarEmpresaId(valor) {
    const empresa_id = String(valor || "").trim()

    if (!empresa_id) {
        return null
    }

    if (!/^\d+$/.test(empresa_id)) {
        return null
    }

    return empresa_id
}


function garantirPastaData() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
    }
}


function pastaSessao(empresa_id) {
    return path.join(
        DATA_DIR,
        "session_" + String(empresa_id)
    )
}


function removerPastaSessao(empresa_id) {
    const pasta = pastaSessao(empresa_id)

    if (fs.existsSync(pasta)) {
        console.log(
            "🧹 Removendo credenciais da empresa",
            empresa_id,
            "em",
            pasta
        )

        fs.rmSync(
            pasta,
            {
                recursive: true,
                force: true
            }
        )
    }
}


async function fecharSocket(sessao) {
    if (!sessao?.sock) {
        return
    }

    try {
        sessao.sock.ev?.removeAllListeners?.()
    } catch (e) {
        console.log("⚠️ Erro removendo listeners:", e)
    }

    try {
        sessao.sock.ws?.close?.()
    } catch (e) {
        console.log("⚠️ Erro fechando websocket:", e)
    }

    sessao.sock = null
}


/*
==========================================
EXTRAIR NUMERO WHATSAPP
==========================================
*/

function extrairNumero(msg) {

    /*
    Prioriza sempre o número telefônico real (PN).
    Em eventos multi-dispositivo o WhatsApp pode também fornecer
    participant/remoteJid em formato @lid; esse identificador
    não deve ser usado como número telefônico.
    */
    if (msg.key?.participantPn)
        return msg.key.participantPn.split("@")[0]

    if (msg.key?.senderPn)
        return msg.key.senderPn.split("@")[0]

    if (msg.key?.participant) {

        const participant = msg.key.participant

        if (
            !participant.includes("@lid") &&
            !participant.includes("@g.us")
        ) {
            return participant.split("@")[0]
        }
    }

    if (msg.key?.remoteJid) {

        const jid = msg.key.remoteJid

        if (jid.includes("@broadcast")) return null
        if (jid.includes("status@broadcast")) return null
        if (jid.includes("@lid")) return null
        if (jid.includes("@g.us")) return null

        return jid.split("@")[0]
    }

    return null
}

/*
==========================================
EXTRAIR TEXTO
==========================================
*/

function desembrulharMensagem(message) {

    let atual = message

    for (let i = 0; i < 5 && atual; i++) {

        if (atual.ephemeralMessage?.message) {
            atual = atual.ephemeralMessage.message
            continue
        }

        if (atual.viewOnceMessage?.message) {
            atual = atual.viewOnceMessage.message
            continue
        }

        if (atual.viewOnceMessageV2?.message) {
            atual = atual.viewOnceMessageV2.message
            continue
        }

        if (atual.viewOnceMessageV2Extension?.message) {
            atual = atual.viewOnceMessageV2Extension.message
            continue
        }

        if (atual.documentWithCaptionMessage?.message) {
            atual = atual.documentWithCaptionMessage.message
            continue
        }

        break
    }

    return atual
}


function extrairTexto(msg) {

    const message =
        desembrulharMensagem(msg.message)

    return (
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        message?.videoMessage?.caption ||
        message?.documentMessage?.caption ||
        message?.buttonsResponseMessage?.selectedButtonId ||
        message?.listResponseMessage?.title ||
        message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message?.templateButtonReplyMessage?.selectedId ||
        ""
    )
}


/*
==========================================
CRIAR SESSÃO WHATSAPP
==========================================
*/

async function iniciarSessao(empresa_id) {

    empresa_id = normalizarEmpresaId(empresa_id)

    if (!empresa_id) {
        throw new Error("empresa_id inválido")
    }

    garantirPastaData()

    if (sessoes[empresa_id] && sessoes[empresa_id].sock) {
        console.log("⚠️ Sessão já existe:", empresa_id)
        return sessoes[empresa_id]
    }

    console.log("🚀 Iniciando sessão empresa", empresa_id)

    const pasta = pastaSessao(empresa_id)

    const { state, saveCreds } =
        await useMultiFileAuthState(pasta)

    const { version } =
        await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        auth: state,
        version,
        browser: ["CapLeads", "Chrome", "1.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        printQRInTerminal: false
    })

    sessoes[empresa_id] = {
        sock,
        qr: null,
        conectado: false,
        encerrando: false,
        erro: null,
        criado_em: Date.now()
    }

    sock.ev.on("creds.update", saveCreds)

    console.log("✅ Socket criado empresa", empresa_id)

    /*
    ==========================================
    STATUS DA CONEXÃO
    ==========================================
    */

    sock.ev.on("connection.update", async (update) => {

        const { connection, qr, lastDisconnect } = update

        const sessao = sessoes[empresa_id]

        if (!sessao) {
            return
        }

        if (qr) {

            try {

                sessao.qr =
                    await qrcode.toDataURL(qr)

                sessao.conectado = false
                sessao.erro = null

                console.log("📱 QR gerado empresa", empresa_id)

            } catch (e) {

                sessao.erro = String(e)

                console.log(
                    "❌ Erro gerar QR empresa",
                    empresa_id,
                    e
                )

            }

        }

        if (connection === "open") {

            sessao.qr = null
            sessao.conectado = true
            sessao.erro = null

            console.log(
                "✅ WhatsApp conectado empresa",
                empresa_id
            )

        }

        if (connection === "close") {

            sessao.conectado = false
            sessao.qr = null

            const statusCode =
                new Boom(
                    lastDisconnect?.error
                )?.output?.statusCode

            const encerrandoManual =
                Boolean(sessao.encerrando)

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut

            console.log(
                "⚠️ Conexão fechada empresa",
                empresa_id,
                "status:",
                statusCode,
                "encerrandoManual:",
                encerrandoManual
            )

            /*
            Logout solicitado pelo CapLeads:
            a própria rota /logout fará a limpeza
            e criará uma nova sessão.
            */
            if (encerrandoManual) {
                return
            }

            delete sessoes[empresa_id]

            if (shouldReconnect) {

                setTimeout(() => {
                    iniciarSessao(empresa_id)
                        .catch((e) => {
                            console.log(
                                "❌ Erro reconectar empresa",
                                empresa_id,
                                e
                            )
                        })
                }, 3000)

            } else {

                /*
                Sessão foi invalidada/logout pelo WhatsApp.
                Remove somente as credenciais deste tenant
                e abre uma sessão nova para gerar QR.
                */
                removerPastaSessao(empresa_id)

                setTimeout(() => {
                    iniciarSessao(empresa_id)
                        .catch((e) => {
                            console.log(
                                "❌ Erro gerar nova sessão empresa",
                                empresa_id,
                                e
                            )
                        })
                }, 1500)

            }

        }

    })

    /*
    ==========================================
    CLIENTE DIGITANDO
    ==========================================
    */

    sock.ev.on("presence.update", async (data) => {

        const jid = Object.keys(data.presences || {})[0]
        if (!jid) return

        const presence = data.presences[jid]
        if (!presence) return

        if (presence.lastKnownPresence === "composing") {

            const numero = jid.split("@")[0]

            try {

                await fetch(
                    CAPLEADS_BASE_URL + "/whatsapp/digitando",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            empresa_id: Number(empresa_id),
                            numero
                        })
                    }
                )

            } catch (e) {

                console.log("Erro digitando:", e)

            }

        }

    })

    /*
    ==========================================
    MENSAGENS RECEBIDAS
    ==========================================
    */

    async function encaminharMensagemRecebida(msg) {

        if (!msg || !msg.key) return

        const jid = msg.key?.remoteJid

        if (msg.key?.fromMe) return
        if (jid && jid.includes("@g.us")) return
        if (jid && jid.includes("@broadcast")) return
        if (jid === "status@broadcast") return

        /*
        Um primeiro evento pode chegar sem conteúdo útil e ser completado
        depois pelo Baileys. Eventos parciais não entram na deduplicação.
        */
        if (!msg.message) return

        const content =
            desembrulharMensagem(msg.message)

        if (!content) return

        const id = msg.key?.id
        const chaveProcessada =
            empresa_id + ":" + String(id || "")

        if (id && mensagensProcessadas.has(chaveProcessada))
            return

        const numero = extrairNumero(msg)
        if (!numero) return

        const texto = extrairTexto({
            ...msg,
            message: content
        })

        if (!texto) {
            console.log(
                "⏳ Mensagem ainda sem texto útil empresa:",
                empresa_id,
                "id:",
                id || "-"
            )
            return
        }

        console.log(
            "📩 Mensagem recebida empresa:",
            empresa_id,
            "numero:",
            numero
        )

        if (id) {
            mensagensProcessadas.add(chaveProcessada)
        }

        if (mensagensProcessadas.size > 2000)
            mensagensProcessadas.clear()

        const controller = new AbortController()
        const timeout = setTimeout(
            () => controller.abort(),
            30000
        )

        try {

            const resposta = await fetch(
                CAPLEADS_BASE_URL + "/whatsapp/receive",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        empresa_id: Number(empresa_id),
                        numero,
                        mensagem: texto,
                        origem: "cliente",
                        nome_whatsapp:
                            String(msg.pushName || "").trim()
                    }),
                    signal: controller.signal
                }
            )

            if (!resposta.ok) {

                if (id) {
                    mensagensProcessadas.delete(chaveProcessada)
                }

                const detalhe =
                    await resposta.text()

                console.log(
                    "❌ Webhook CapLeads retornou",
                    resposta.status,
                    detalhe
                )

            } else {

                console.log(
                    "✅ Webhook enviado ao CapLeads empresa",
                    empresa_id
                )

            }

        } catch (e) {

            if (id) {
                mensagensProcessadas.delete(chaveProcessada)
            }

            console.log(
                e?.name === "AbortError"
                    ? "⏱️ Timeout webhook CapLeads"
                    : "Erro webhook:",
                e
            )

        } finally {

            clearTimeout(timeout)

        }
    }

    sock.ev.on(
        "messages.upsert",
        ({ messages, type }) => {

            if (type !== "notify") return

            /*
            Um upsert pode conter várias mensagens. Cada uma segue
            independentemente para o CapLeads, evitando que uma chamada
            lenta da IA segure as mensagens seguintes.
            */
            for (const msg of messages || []) {
                void encaminharMensagemRecebida(msg)
            }

        }
    )

    /*
    Mensagens que chegam inicialmente incompletas podem ganhar conteúdo
    em messages.update. Reutilizamos o mesmo pipeline; como a mensagem só
    é marcada como processada depois que existe texto, a atualização
    posterior ainda pode chegar ao CapLeads.
    */
    sock.ev.on(
        "messages.update",
        (updates) => {

            for (const item of updates || []) {

                const mensagemAtualizada = {
                    key: item?.key,
                    message: item?.update?.message,
                    pushName:
                        item?.update?.pushName || ""
                }

                if (
                    mensagemAtualizada.key &&
                    mensagemAtualizada.message
                ) {
                    void encaminharMensagemRecebida(
                        mensagemAtualizada
                    )
                }
            }

        }
    )

    /*
    Não reiniciamos mais uma sessão saudável apenas porque ainda não
    apareceu conexão/QR. O handshake do Baileys pode levar dezenas de
    segundos e o próprio socket já possui connectTimeoutMs=60000.

    A versão anterior reiniciava após 12 segundos e /status e /qr chamam
    esta função repetidamente; na prática a própria tela podia interromper
    o handshake antes de ele terminar.

    Falhas reais continuam sendo tratadas por connection.update/close,
    que reconecta o socket preservando as credenciais quando apropriado.
    */

    return sessao
}

/*
==========================================
CONNECT
==========================================
*/

app.post("/connect", async (req, res) => {

    const empresa_id =
        normalizarEmpresaId(req.body?.empresa_id)

    if (!empresa_id) {
        return res.status(400).json({
            erro: "empresa_id obrigatório"
        })
    }

    try {

        const sessao =
            await garantirSessao(empresa_id)

        return res.json({
            status: sessao?.conectado
                ? "conectado"
                : "iniciando",
            empresa_id: Number(empresa_id),
            connected: Boolean(
                sessao?.conectado
            ),
            qr: sessao?.qr || null
        })

    } catch (e) {

        console.log(
            "❌ Erro iniciar sessão:",
            e
        )

        return res.status(500).json({
            erro: String(e)
        })

    }

})

/*
==========================================
QR CODE
==========================================
*/

app.get("/qr", async (req, res) => {

    const empresa_id =
        normalizarEmpresaId(req.query.empresa_id)

    if (!empresa_id)
        return res.json({
            qr: null,
            connected: false
        })

    try {

        const sessao =
            await garantirSessao(empresa_id)

        return res.json({
            empresa_id: Number(empresa_id),
            qr: sessao?.qr || null,
            connected:
                sessao?.conectado || false,
            erro:
                sessao?.erro || null
        })

    } catch (e) {

        return res.status(500).json({
            qr: null,
            connected: false,
            erro: String(e)
        })

    }

})

/*
==========================================
STATUS
==========================================
*/

app.get("/status", async (req, res) => {

    const empresa_id =
        normalizarEmpresaId(req.query.empresa_id)

    if (!empresa_id)
        return res.json({
            connected: false
        })

    try {

        const sessao =
            await garantirSessao(empresa_id)

        return res.json({
            empresa_id: Number(empresa_id),
            connected:
                sessao?.conectado || false,
            qr_disponivel:
                Boolean(sessao?.qr),
            erro:
                sessao?.erro || null
        })

    } catch (e) {

        return res.status(500).json({
            connected: false,
            erro: String(e)
        })

    }

})

/*
==========================================
ENVIAR MENSAGEM
==========================================
*/

app.post("/send", async (req, res) => {

    const empresa_id =
        normalizarEmpresaId(req.body?.empresa_id)

    const numero =
        String(req.body?.numero || "")
            .replace(/\D/g, "")

    const mensagem =
        String(req.body?.mensagem || "")
            .trim()

    const imagem_base64 =
        String(req.body?.imagem_base64 || "")
            .trim()

    const imagem_mime =
        String(req.body?.imagem_mime || "")
            .trim()
            .toLowerCase()

    const mimesPermitidos = new Set([
        "image/jpeg",
        "image/png",
        "image/webp"
    ])

    if (!empresa_id || !numero || (!mensagem && !imagem_base64))
        return res.status(400).json({
            status: "erro",
            erro: "dados inválidos"
        })

    if (imagem_base64 && !mimesPermitidos.has(imagem_mime)) {
        return res.status(400).json({
            status: "erro",
            erro: "tipo de imagem não permitido"
        })
    }

    if (imagem_base64 && imagem_base64.length > 7_000_000) {
        return res.status(413).json({
            status: "erro",
            erro: "imagem muito grande"
        })
    }

    try {

        const sessao =
            await garantirSessao(empresa_id)

        if (
            !sessao ||
            !sessao.sock
        ) {
            return res.status(409).json({
                status: "erro",
                erro: "sessão não encontrada"
            })
        }

        if (!sessao.conectado) {
            return res.status(409).json({
                status: "erro",
                erro: "whatsapp não conectado",
                connected: false
            })
        }

        const jid =
            numero + "@s.whatsapp.net"

        let conteudoMensagem

        if (imagem_base64) {
            let bufferImagem

            try {
                bufferImagem = Buffer.from(
                    imagem_base64,
                    "base64"
                )
            } catch (e) {
                return res.status(400).json({
                    status: "erro",
                    erro: "imagem base64 inválida"
                })
            }

            if (!bufferImagem?.length) {
                return res.status(400).json({
                    status: "erro",
                    erro: "imagem vazia"
                })
            }

            conteudoMensagem = {
                image: bufferImagem,
                mimetype: imagem_mime
            }

            if (mensagem) {
                conteudoMensagem.caption = mensagem
            }
        } else {
            conteudoMensagem = {
                text: mensagem
            }
        }

        const resultado =
            await sessao.sock.sendMessage(
                jid,
                conteudoMensagem
            )

        console.log(
            "✅ WhatsApp enviado empresa",
            empresa_id,
            "numero",
            numero,
            "id",
            resultado?.key?.id || "-"
        )

        return res.json({
            status: "ok",
            empresa_id: Number(empresa_id),
            numero,
            message_id:
                resultado?.key?.id || null
        })

    } catch (e) {

        console.log(
            "❌ Erro envio empresa",
            empresa_id,
            e
        )

        return res.status(500).json({
            status: "erro",
            erro: String(e)
        })

    }

})

/*
==========================================
LOGOUT / DESCONECTAR
==========================================
*/

app.post("/logout", async (req, res) => {

    const empresa_id =
        normalizarEmpresaId(req.body?.empresa_id)

    if (!empresa_id) {
        return res.status(400).json({
            ok: false,
            erro: "empresa_id obrigatório"
        })
    }

    console.log(
        "🚪 Solicitação de logout empresa",
        empresa_id
    )

    try {

        const sessao =
            sessoes[empresa_id]

        if (sessao) {

            /*
            Impede que o connection.close provocado
            pelo logout faça uma reconexão concorrente.
            */
            sessao.encerrando = true

            if (sessao.sock) {

                try {

                    await sessao.sock.logout()

                } catch (e) {

                    /*
                    Se a sessão já estiver quebrada/desconectada,
                    ainda assim a pasta será removida.
                    */
                    console.log(
                        "⚠️ sock.logout empresa",
                        empresa_id,
                        String(e)
                    )

                }

            }

            await fecharSocket(sessao)

        }

        /*
        Remove SOMENTE a sessão deste tenant.
        */
        removerPastaSessao(empresa_id)

        delete sessoes[empresa_id]

        /*
        Cria imediatamente uma sessão limpa.
        O QR pode levar alguns segundos para chegar
        via connection.update, e a tela já consulta /qr.
        */
        const novaSessao =
            await iniciarSessao(empresa_id)

        return res.json({
            ok: true,
            empresa_id: Number(empresa_id),
            connected:
                Boolean(novaSessao?.conectado),
            qr:
                novaSessao?.qr || null,
            message:
                "Sessão limpa. Aguardando novo QR Code."
        })

    } catch (e) {

        console.log(
            "❌ Erro logout empresa",
            empresa_id,
            e
        )

        /*
        Mesmo se o socket falhar, tentamos remover
        o estado local para permitir reconexão posterior.
        */
        try {
            removerPastaSessao(empresa_id)
            delete sessoes[empresa_id]
        } catch (_) {
            // sem ação
        }

        return res.status(500).json({
            ok: false,
            erro: String(e)
        })

    }

})

/*
==========================================
HEALTH
==========================================
*/

app.get("/health", (_req, res) => {

    return res.json({
        ok: true,
        service: "capleads-connector",
        sessoes: Object.keys(sessoes).length
    })

})

/*
==========================================
RESTAURAR SESSÕES
==========================================
*/

function restaurarSessoes() {

    garantirPastaData()

    const dirs =
        fs.readdirSync(DATA_DIR)

    dirs.forEach((dir) => {

        if (dir.startsWith("session_")) {

            const empresa_id =
                dir.replace("session_", "")

            if (!normalizarEmpresaId(empresa_id)) {
                return
            }

            console.log(
                "🔄 Restaurando sessão empresa",
                empresa_id
            )

            iniciarSessao(empresa_id)
                .catch((e) => {
                    console.log(
                        "❌ Erro restaurar empresa",
                        empresa_id,
                        e
                    )
                })

        }

    })

}

/*
==========================================
START SERVER
==========================================
*/

garantirPastaData()

app.listen(
    PORT,
    () => {

        console.log(
            "🚀 Connector WhatsApp rodando porta",
            PORT
        )

        console.log(
            "📁 Pasta de sessões:",
            DATA_DIR
        )

        console.log(
            "🔗 CapLeads:",
            CAPLEADS_BASE_URL
        )

        restaurarSessoes()

    }
)






