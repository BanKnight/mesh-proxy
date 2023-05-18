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

        this.createConnection(this.options.pass, context, (error: Error | null, tunnel: Tunnel | null) => {
            if (error) {
                console.error(error)
                return
            }
            process.stdin.pipe(tunnel)
        })
    }

    close() {

    }

    connection(tunnel: Tunnel, context: any, callback: ConnectListener) {

        callback()

        tunnel.pipe(process.stdout)
    }
}