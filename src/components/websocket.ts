import * as http from 'http';
import * as https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import ws from 'ws';
import { Component, ComponentOption, ConnectListener, Tunnel } from "../types.js";
import { Duplex } from 'stream';

type IdWsSocket = ws.WebSocket & { id: string }

export default class Tcp extends Component {
    id: number = 0
    server?: ws.Server
    sockets: Record<string, IdWsSocket> = {}        //[remote_id] = socket 

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {

        if (this.options.listen) {
            this.listen()
        }
    }

    close(error?: Error) {
        this.server?.removeAllListeners()
        this.server?.close()

        for (let id in this.sockets) {
            const socket = this.sockets[id]
            socket.close()
        }
    }

    listen() {
        let http_or_https: http.Server | https.Server
        if (this.options.key && this.options.cert)       //wss
        {
            let http_option = {
                key: this.options.key,
                cert: this.options.cert,
            }

            if (http_option.key.startsWith("file://")) {
                const file = fileURLToPath(http_option.key);
                http_option.key = readFileSync(file, "utf-8")
            }

            if (http_option.cert.startsWith("file://")) {
                const file = fileURLToPath(http_option.cert);
                http_option.cert = readFileSync(file, "utf-8")
            }

            http_or_https = https.createServer(http_option)
        }
        else {
            http_or_https = http.createServer()
        }

        this.server = new ws.Server({ server: http_or_https, path: this.options.path });

        this.server.on('connection', (socket: ws.WebSocket & { id: string }, req: http.IncomingMessage) => {

            socket.id = `${this.name}/${++this.id}`

            const context = {
                source: {
                    socket: {
                        remoteAddress: req.socket.remoteAddress,
                        remotePort: req.socket.remotePort
                    }
                }
            }

            const duplex = ws.createWebSocketStream(socket)
            const tunnel = this.createConnection(this.options.pass, context)

            duplex.pipe(tunnel).pipe(duplex)

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(3000)

            this.sockets[socket.id] = socket

            duplex.on("close", () => {
                delete this.sockets[socket.id]
                tunnel.end()
            })

            tunnel.once("error", (e) => {
                socket.close()
                tunnel.destroy()
            })
        });

        http_or_https.listen(this.options.port, () => {
            console.log(`component[${this.name}] listen:${this.options.port}`);
        })

        this.server.on('error', (e: any) => {

            if (e.code == 'EADDRINUSE') {
                console.error(e)
                //Retry
                return
            }

            // if (proxy.server.force) {
            //     return
            // }
        });
    }
    connection(tunnel: Tunnel, context: any, callback: ConnectListener) {

        if (this.options.address == null) {
            const error = new Error(`component[${this.name}]:no component`)
            callback(error)
            return
        }

        callback()

        const socket = new ws.WebSocket(this.options.url, this.options as unknown) as IdWsSocket
        const stream = ws.createWebSocketStream(socket)

        stream.on("error", () => {
            tunnel.end()
            stream.destroy()
        })
        stream.on("close", () => {
            tunnel.end()
        })
        tunnel.on("error", () => {
            stream.destroy()
            tunnel.end()
        })
        tunnel.pipe(stream).pipe(tunnel)
    }
}