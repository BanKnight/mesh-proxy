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
        this.on("connection", (tunnel: Tunnel, context: any, callback: Function) => {

            const socket = createConnection(this.options.connect || context.dest, () => {
                callback()
                this.on_new_socket(socket, tunnel)
            })

            socket.once("error", (error: Error) => {
                if (socket.pending) {
                    callback(error)
                }
            })
        })
    }

    on_new_socket(socket: Socket, tunnel: Tunnel) {

        this.sockets[socket.id] = socket

        socket.setKeepAlive(true)
        socket.setNoDelay(true)

        socket.pipe(tunnel).pipe(socket)
        socket.on('close', (has_error) => {
            delete this.sockets[socket.id]
        });
    }
}