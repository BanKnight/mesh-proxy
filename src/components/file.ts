import { Component, ComponentOption, ConnectListener, Tunnel } from "../types.js";
import fs from "fs"
import path from "path"
export default class File extends Component {

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
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

        const temp_name = Date.now().toString()

        const filename = context.source.path ? path.basename(context.source.path) : temp_name
        const folder = this.options.path || "./files"
        const whole = path.join(folder, filename)

        try {
            fs.mkdirSync(folder, { recursive: true })
        }
        catch (e) { }

        const stream = fs.createWriteStream(whole)

        tunnel.pipe(stream)
        tunnel.on("end", () => {
            tunnel.end()
            stream.end()
        })
        stream.on("finish", () => {
            tunnel.end()
        })

        console.log("writing to", whole)
    }
}