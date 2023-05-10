import { Server, Socket, createServer, connect } from "net";
import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Free extends Component {
    id: number = 0
    server?: Server
    sockets: Record<string, Socket> = {}        //[tunnel][remote_id] = socket 

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {


    }

    close(error?: Error) {
        this.server?.removeAllListeners()
        this.server?.close()

        for (let id in this.sockets) {
            const socket = this.sockets[id]
            socket.resetAndDestroy()
        }
    }

    connection() {

        this.on("connection", (tunnel: Tunnel, source: any, destination: { address: string, port: number, protocol?: "tcp" | "udp" }) => {

            console.log("on connection", destination.address, destination.port)

            if (destination.port == null || destination.address == null) {
                tunnel.destroy(new Error(`unknown next pass in ${this.name}`))
                return
            }

            switch (destination.protocol) {
                case "tcp":
                    this.handle_tcp(tunnel, source, destination)
                    break
                case "udp":
                    this.handle_tcp(tunnel, source, destination)
                    break
                default:
                    tunnel.destroy(new Error(`unknown protocol type:${destination.protocol}`))
                    break
            }
        })
    }

    handle_tcp(tunnel: Tunnel, source: any, destination: { address: string, port: number, protocol?: "tcp" | "udp" }) {

        const socket = new Socket()

        this.sockets[socket.id] = socket

        this.on_new_socket(socket, tunnel)

        socket.connect(destination.port, destination.address)
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