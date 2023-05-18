import { Component, ComponentOption, ConnectListener, Tunnel } from "../types.js";

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

    connection(tunnel: Tunnel, context: any, callback: Function) {
        if (this.options.pass == null) {
            callback(new Error(`"component[${this.name}] pass required`))
            tunnel.destroy()
            return
        }
        this.createConnection(this.options.pass, context, (error: Error | null, remote?: Tunnel) => {
            callback(error)
            if (error) {
                return
            }
            tunnel.pipe(remote).pipe(tunnel)
        })
    }

    close() {

    }
}