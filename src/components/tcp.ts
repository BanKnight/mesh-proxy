import { Server, Socket, createServer, createConnection } from "net";
import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Tcp extends Component {
    id: number = 0
    server?: Server

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
            socket.on('close', (has_error) => {
                tunnel.destroy()
                socket.destroy()
            });
            socket.on("error", () => {
                socket.destroy()
                tunnel.destroy()
            })

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

            socket.setKeepAlive(true)
            socket.setNoDelay(true)
            socket.pipe(tunnel).pipe(socket)
            socket.on('close', (has_error) => {
                tunnel.end()
                socket.destroy()
            });

            socket.on("error", (error: Error) => {
                if (socket.pending) {
                    callback(error)
                }
            })
        })
    }
}