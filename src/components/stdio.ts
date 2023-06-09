import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
export default class Stdio extends Component {

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {
        if (!this.options.input) {
            return
        }

        const context = {
            source: {}
        }

        const tunnel = this.createConnection(this.options.pass, context)

        if (tunnel == null) {
            console.error("cant tunnel to pass", this.options.pass)
            return
        }

        process.stdin.pipe(tunnel)

        tunnel.once("error", (e) => {
            process.stdin.unpipe(tunnel)
            tunnel.destroy(e)
        })
    }

    close() { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {
        callback()
        tunnel.pipe(process.stdout)
    }
}