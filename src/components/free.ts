import * as dgram from 'dgram';
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
    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() { }

    close(error?: Error) { }

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

        if (this.options.debug) {
            console.log(this.name, "tcp connect", context.dest.host, context.dest.port)
        }

        const socket = createConnection(context.dest)

        socket.setKeepAlive(true)
        socket.setNoDelay(true)
        socket.setTimeout(0)

        socket.pipe(tunnel).pipe(socket)

        socket.on('end', (has_error) => {
            tunnel.end()
            socket.destroy()

            console.log(this.name, "tcp xx", context.dest.host, context.dest.port)
        });

        socket.on('close', (has_error) => {
            tunnel.end()
            socket.destroy()

            console.log(this.name, "tcp xx", context.dest.host, context.dest.port)
        });

        socket.on("error", () => {
            tunnel.end()
            socket.destroy()
        })

        // tunnel.on("data", (data) => {
        //     console.log(this.name, "tcp ==>", context.dest.host, context.dest.port, data.length)
        // })

        // socket.on("data", (data) => {
        //     console.log(this.name, "tcp <==", context.dest.host, context.dest.port, data.length)
        // })
    }

    handle_udp(tunnel: Tunnel, context: Context) {

        if (this.options.debug) {
            console.log(this.name, "udp connect", context.dest.host, context.dest.port)
        }

        const socket = dgram.createSocket("udp4")

        socket.connect(context.dest.port, context.dest.host)

        socket.on("message", (buffer) => {
            tunnel.write(buffer)
        })

        socket.on("error", () => {
            socket.close()
            tunnel.end()
        })

        socket.on("close", () => {
            socket.close()
            tunnel.end()
        })

        tunnel.on("data", (buffer) => {
            socket.send(buffer)
        })

        tunnel.on("error", () => {
            socket.close()
            tunnel.end()
        })

        tunnel.on("end", () => {
            socket.close()
            tunnel.end()
        })
        tunnel.on("close", () => {
            socket.close()
            tunnel.end()
        })
    }

}