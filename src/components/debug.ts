import { Server, Socket, createServer, createConnection } from "net";
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import { writeHeapSnapshot } from "v8"
export default class Debug extends Component {

    server?: Server

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {
        this.server = createServer()
        this.server.on("listening", () => {
            console.log(`component[${this.name}] is listening ${this.options.listen}`)
        })

        this.server.on('connection', (socket: Socket) => {

            // const now = new Date()

            setTimeout(() => {
                writeHeapSnapshot()
                console.log("snapshot")
            }, 3000)

            socket.destroy()
        })

        this.server.on('error', (e: any) => {
            if (e.code == 'EADDRINUSE') {
                console.error(e)
                return
            }
        });

        this.server.listen(this.options.listen)
    }

    close() { }
}