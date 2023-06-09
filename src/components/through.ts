import { finished } from "stream";
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";

export default class Through extends Component {
    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {
        if (this.options.pass == null) {
            console.error(Error(`"component[${this.name}] pass required`))
            return
        }
    }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {
        if (this.options.pass == null) {
            tunnel.destroy(new Error(`"component[${this.name}] pass required`))
            return
        }

        const next = this.createConnection(this.options.pass, context, callback)

        if (next == null) {
            console.error("cant tunnel to pass", this.options.pass)
            tunnel.destroy()
            return
        }

        tunnel.pipe(next).pipe(tunnel)

        finished(tunnel, () => {
            next.destroy()
        })

        finished(next, () => {
            tunnel.destroy()
        })

        // next.on("error", (e) => {
        //     tunnel.destroy(e)
        //     next.destroy()
        // })

        // tunnel.on("error", () => {
        //     tunnel.destroy()
        //     next.destroy()
        // })
    }

    close() {

    }
}