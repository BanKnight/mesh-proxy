import { clearInterval } from "timers";
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";

export default class Hole extends Component {
    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() { }
    close() { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        if (this.options.response == "http") {
            callback({
                statusCode: 40,
                statusMessage: "blackhole",
            })

            return
        }

        console.log(this.name, "connect", context.dest.host, context.dest.port)

        let last = Date.now()
        let timer = null

        tunnel.on("data", (data) => {
            last = Date.now()
        })
        tunnel.on("error", () => {
            tunnel.end()
        })
        tunnel.on("end", () => {
            tunnel.end()
        })
        tunnel.on("close", () => {
            tunnel.end()

            if (timer) {
                clearInterval(timer)
            }
        })

        if (!this.options.timeout) {
            return
        }

        timer = setInterval(() => {
            if (Date.now() - last > this.options.timeout) {
                tunnel.destroy()
                clearInterval(timer)
            }
        }, this.options.timeout * 1.02)

    }
}