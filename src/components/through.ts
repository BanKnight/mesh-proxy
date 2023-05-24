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
            callback(new Error(`"component[${this.name}] pass required`))
            tunnel.destroy()
            return
        }
        const next = this.createConnection(this.options.pass, context, () => {
            callback()
            tunnel.pipe(next).pipe(tunnel)
        })

        next.on("error", (e) => {
            if (next.readyState == "opening") {
                callback(e)
            }
            tunnel.destroy()
            next.destroy()
        })

        tunnel.on("error", () => {
            tunnel.destroy()
            next.destroy()
        })
    }

    close() {

    }
}