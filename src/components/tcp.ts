import { Server, Socket, createServer, connect } from "net";
import tls from "tls"
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
            this.createConnection(this.options.pass, context, (error: Error | undefined, tunnel: Tunnel) => {
                if (error) {
                    socket.destroy(error)
                    return
                }
                this.on_new_socket(socket, tunnel)
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

        const index = this.options.pass?.indexOf(":")
        const host = this.options.pass?.substring(0, index)
        const port = this.options.pass?.substring(index + 1)

        this.on("connection", (tunnel: Tunnel, info: any, destination: any) => {

            const target_host = destination?.address || host
            const target_port = destination?.port || port

            console.log("on connection", target_host, target_port)

            if (target_host == null || target_port == null) {
                tunnel.destroy(new Error(`unknown next pass in ${this.name}`))
                return
            }

            const socket = new Socket()

            this.sockets[socket.id] = socket

            this.on_new_socket(socket, tunnel)

            socket.connect(target_port, target_host)
        })
    }

    on_new_socket(socket: Socket, tunnel: Tunnel) {

        socket.setKeepAlive(true)

        socket.pipe(tunnel)
        tunnel.pipe(socket)

        tunnel.on("error", () => {
            tunnel.destroy()
            socket.destroy()
        })

        tunnel.on("close", () => {
            tunnel.destroy()
            socket.destroy()
        })

        socket.on("error", () => {
            socket.destroy()
            tunnel.destroy()
        })

        socket.on("end", () => {
            tunnel.destroy()
            socket.destroy()
        })

        socket.on('close', (has_error) => {
            delete this.sockets[socket.id]
        });

    }
}