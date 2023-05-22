import { Socket, createSocket } from "dgram";
import { Component, ComponentOption, Tunnel } from "../types.js";

interface Session {
    id: string;
    protocol: "tcp" | "udp";
    port: number;
    host: string;
    tunnel?: Tunnel
}

export default class udp extends Component {
    id: number = 0
    server?: Socket
    sessions: Record<string, Session> = {}

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

        const socket = this.server = createSocket("udp4")

        this.server.on("listening", () => {
            console.log(`component[${this.name}] is listening ${this.options.listen}`)
        })

        this.server.on('message', (message, remote_info) => {

            const id = `udp://${remote_info.address}:${remote_info.port}`
            let session = this.sessions[id]

            if (session) {
                session.tunnel.write(message)
                return
            }

            this.sessions[session.id] = session = {
                id,
                port: remote_info.port,
                host: remote_info.address,
                protocol: "udp",
            } as Session

            const context = {
                source: {
                    socket: {
                        protocol: "udp",
                        remoteAddress: remote_info.address,
                        remotePort: remote_info.port,
                        family: remote_info.family, //IPV4/IPV6
                    }
                }
            }

            session.tunnel = this.createConnection(this.options.pass, context)
            session.tunnel.write(message)

            socket.on("close", () => {
                socket.close()
                session.tunnel.end()
            })

            session.tunnel.on("data", (buffer) => {
                socket.send(buffer, remote_info.port, remote_info.address)
            })

            session.tunnel.on("error", () => { })
            session.tunnel.on("end", () => {
                session.tunnel.end()
            })

            session.tunnel.on("close", () => {
                session.tunnel.end()
            })

            session.tunnel.write(message)
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

        this.server.bind(this.options.listen.port || this.options.listen, this.options.listen.host)
    }

    connect() {
        this.on("connection", (tunnel: Tunnel, context: any, callback: Function) => {

            callback()

            const socket = createSocket("udp4")

            socket.connect(this.options.connect.port, this.options.connect.host)
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
        })
    }
}