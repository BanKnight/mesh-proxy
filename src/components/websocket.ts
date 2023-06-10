import * as http from 'http';
import * as https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import ws from 'ws';
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import { finished } from 'stream';

type IdWsSocket = ws.WebSocket & { id: string }

export default class Tcp extends Component {
    id: number = 0
    server?: ws.Server

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

            const context: ConnectionContext = {
                src: {
                    socket: {
                        remoteAddress: req.socket.remoteAddress,
                        remotePort: req.socket.remotePort,
                        family: req.socket.remoteFamily,
                        protocol: "tcp",
                    }
                }
            }

            const duplex = ws.createWebSocketStream(socket)
            const tunnel = this.createConnection(this.options.pass, context)

            duplex.pipe(tunnel).pipe(duplex)

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(3000)

            const destroy = () => {
                if (!tunnel.destroyed) {
                    tunnel.destroy()
                }

                if (!duplex.destroyed) {
                    duplex.destroy()
                }
            }
            finished(duplex, destroy)
            finished(tunnel, destroy)
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
    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        if (this.options.address == null) {
            const error = new Error(`component[${this.name}]:no component`)
            tunnel.destroy(error)
            return
        }

        callback()

        const socket = new ws.WebSocket(this.options.url, this.options as unknown) as IdWsSocket
        const stream = ws.createWebSocketStream(socket)

        tunnel.pipe(stream).pipe(tunnel)

        const destroy = () => {
            if (!tunnel.destroyed) {
                tunnel.destroy()
            }

            if (!stream.destroyed) {
                stream.destroy()
            }
        }
        finished(stream, destroy)
        finished(tunnel, destroy)
    }
}