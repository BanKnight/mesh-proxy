import * as http from 'http';
import * as https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as WebSocket from 'ws';
import { Component, ComponentOption, Tunnel } from "../types.js";

type IdWsSocket = WebSocket & { id: string }

export default class Tcp extends Component {
    id: number = 0
    server?: WebSocket.Server
    sockets: Record<string, WebSocket> = {}        //[remote_id] = socket 

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        if (this.options.port) {
            this.listen()
        }
        else {
            this.connect()
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

        this.server = new WebSocket.Server({ server: http_or_https, path: this.options.path });

        this.server.on('connection', (socket: WebSocket & { id: string }, req: http.IncomingMessage) => {

            socket.id = `${this.name}/${++this.id}`

            this.sockets[socket.id] = socket

            const tunnel = this.create_tunnel()

            this.on_new_socket(socket, tunnel)

            tunnel.connect(this.options.pass,
                {
                    address: req.socket.remoteAddress,
                    port: req.socket.remotePort
                }
            )

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(3000)
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
    connect() {
        this.on("connection", (tunnel: Tunnel, source: any, destination: any) => {
            if (this.options.address == null) {
                tunnel.destroy(new Error(`component[${this.name}]:no component`))
                return
            }

            console.log("on connection", source?.address, source?.port)

            const socket = new WebSocket(this.options.address) as IdWsSocket

            socket.id = `${this.name}/${++this.id}`

            this.sockets[socket.id] = socket

            this.on_new_socket(socket, tunnel)
        })
    }

    on_new_socket(socket: IdWsSocket, tunnel: Tunnel) {

        const timer = setInterval(() => {
            if (socket.readyState == socket.OPEN) {
                socket.ping()
            }
            else {
                clearInterval(timer)
            }
        }, this.options.timeout || 10000)

        socket.on("message", (data) => {
            tunnel.push(data)
        })

        tunnel.on("data", (data) => {
            socket.send(data)
        })

        socket.on('close', () => {
            tunnel.push(null);
            tunnel.end();
        });

        tunnel.on("error", () => {
            tunnel.destroy()
            socket.close()
        })

        socket.on("error", (error) => {
            socket.close()
            tunnel.destroy(error)
        })

        tunnel.on("close", () => {
            tunnel.destroy()
            socket.close()
        })
    }
}