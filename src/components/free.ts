import { Socket, createConnection } from "net";
import { Component, ComponentOption, Tunnel } from "../types.js";

interface Context {
    dest: {
        host: string,
        port: number,
        protocol: "tcp" | "udp"
    }
}
export default class Free extends Component {
    id: number = 0
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

        for (let id in this.sockets) {
            const socket = this.sockets[id]
            socket.resetAndDestroy()
        }
    }

    connection(tunnel: Tunnel, context: Context, callback: Function) {

        callback()

        const dest = context.dest

        switch (dest.protocol) {
            case "tcp":
                this.handle_tcp(tunnel, context)
                break
            case "udp":
                this.handle_udp(tunnel, context)
                break
            default:
                tunnel.destroy(new Error(`unknown protocol type:${dest.protocol}`))
                break
        }
    }

    handle_tcp(tunnel: Tunnel, context: Context) {

        const socket = createConnection(context.dest)

        socket.setKeepAlive(true)
        socket.setNoDelay(true)

        socket.pipe(tunnel).pipe(socket)

        this.sockets[socket.id] = socket

        socket.on('close', (has_error) => {
            delete this.sockets[socket.id]
        });
    }

    handle_udp(tunnel: Tunnel, context: Context) {


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