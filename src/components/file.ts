import { Component, ComponentOption, ConnectListener, Tunnel } from "../types.js";
import fs from "fs"
import path from "path"
export default class Tcp extends Component {

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.close.bind(this))
    }

    ready() {
        if (this.options.input == null) {
            return
        }

        const context = {
            source: {
                path: this.options.path
            }
        }

        const tunnel = this.createConnection(this.options.pass, context, () => {
            const stream = fs.createReadStream(this.options.path)
            stream.pipe(tunnel)
        })

        tunnel.once("error", (e) => {
            tunnel.destroy(e)
        })
    }

    close() {

    }

    connection(tunnel: Tunnel, context: any, callback: ConnectListener) {

        callback()

        const temp_name = (new Date()).toLocaleString()

        const filename = context.source.path ? path.basename(context.source.path) : temp_name
        const folder = this.options.path || "./files"
        const whole = path.join(folder, filename)

        fs.mkdirSync(folder, { recursive: true })

        const stream = fs.createWriteStream(whole)

        tunnel.pipe(stream)
    }
}