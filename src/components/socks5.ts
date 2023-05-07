import { Socket } from "net";
import { Component, ComponentOption, Tunnel } from "../types.js";
import * as socks5 from "../protocols/socks5.js"

export default class Socks5 extends Component {
    id: number = 0
    server?: any
    sockets: Record<number, Socket> = {}

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
    close() {

        this.server?.close()

        for (let id in this.sockets) {
            const socket = this.sockets[id]
            socket.resetAndDestroy()
        }
    }

    listen() {

        const server = this.server = socks5.createServer()

        server.on("connecting", async (socket: Socket, destination: any, origin: any) => {

            socket.id = `${this.name}/${++this.id}`

            this.sockets[socket.id] = socket

            const tunnel = this.create_tunnel()

            this.on_new_socket(socket, tunnel)

            tunnel.connect(this.options.pass, destination, origin)
        })

        this.server.on("listening", () => {
            console.log(this.name, `is listening`, this.options.port)
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


        this.server.listen(this.options.port)
    }

    connect() {

        this.on("connection", (tunnel: Tunnel, destination: any, origin: any) => {

            const socket = new Socket()

            socket.id = tunnel.id

            this.sockets[socket.id] = socket

            this.on_new_socket(socket, tunnel)

            socket.connect(destination.port, destination.address)
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