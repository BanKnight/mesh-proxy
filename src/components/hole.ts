import { Component, ComponentOption, ConnectListener, Tunnel } from "../types.js";

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

    connection(tunnel: Tunnel, context: any, callback: Function) {

        if (this.options.response == "http") {
            callback(null, {
                statusCode: 40,
                statusMessage: "blackhole",
            })
        }
        else {
            callback()
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