import { Server, Socket, createServer, createConnection } from "net";
import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Tcp extends Component {
    id: number = 0
    server?: Server
    sockets: Record<string, Socket> = {}        //[tunnel][remote_id] = socket 

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        if (this.options.listen) {
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
            socket.resetAndDestroy()
        }
    }

    listen() {

        this.server = createServer()

        this.server.on("listening", () => {
            console.log(`component[${this.name}] is listening ${this.options.listen}`)
        })

        this.server.on('connection', (socket: Socket) => {

            socket.id = `${this.name}/${++this.id}`

            const context = {
                source: {
                    socket: {
                        remoteAddress: socket.remoteAddress, remotePort: socket.remotePort
                    }
                }
            }
            const tunnel = this.createConnection(this.options.pass, context)

            socket.setKeepAlive(true)
            socket.setNoDelay(true)
            socket.pipe(tunnel).pipe(socket)

            this.sockets[socket.id] = socket

            socket.on('close', (has_error) => {
                delete this.sockets[socket.id]
                tunnel.end()
            });

            tunnel.once("error", (e) => {
                socket.destroy()
                tunnel.destroy()
            })
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

        this.server.listen(this.options.listen)
    }

    connect() {
        this.on("connection", (tunnel: Tunnel, context: any, callback: Function) => {

            const socket = createConnection(this.options.connect || context.dest, () => {
                callback()
            })

            socket.id = `${this.name}/${++this.id}`

            socket.setKeepAlive(true)
            socket.setNoDelay(true)
            socket.pipe(tunnel).pipe(socket)

            this.sockets[socket.id] = socket

            socket.on('close', (has_error) => {
                delete this.sockets[socket.id]
                tunnel.end()
            });

            socket.on("error", (error: Error) => {
                if (socket.pending) {
                    callback(error)
                }
            })
        })
    }
}