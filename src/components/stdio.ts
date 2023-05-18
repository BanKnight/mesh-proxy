import { Component, ComponentOption, ConnectListener, Tunnel } from "../types.js";
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

        const tunnel = this.createConnection(this.options.pass, context, (tunnel: Tunnel) => {
            process.stdin.pipe(tunnel)
        })

        tunnel.once("error", (e) => {
            tunnel.destroy(e)
        })
    }

    close() {

    }

    connection(tunnel: Tunnel, context: any, callback: ConnectListener) {

        callback()

        tunnel.pipe(process.stdout)
    }
}