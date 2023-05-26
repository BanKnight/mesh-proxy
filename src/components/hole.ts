import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";

export default class Hole extends Component {
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

        if (this.options.response == "http") {
            callback({
                statusCode: 40,
                statusMessage: "blackhole",
            })

            return
        }

        tunnel.on("data", (data) => { })
        tunnel.on("error", () => {
            tunnel.end()
        })
        tunnel.on("end", () => {
            tunnel.end()
        })
        tunnel.on("close", () => {
            tunnel.end()
        })
    }

    close() {

    }
}