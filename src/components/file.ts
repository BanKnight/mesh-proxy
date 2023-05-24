import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
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
        this.options.root = this.options.root || "./files"
    }

    close() { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        callback()

        if (this.options.input) {
            this.read_file(tunnel, context)
        }
        else {
            this.write_file(tunnel, context)
        }
    }

    write_file(tunnel: Tunnel, context: ConnectionContext) {

        const whole = this.prepare(context)
        const parent = path.resolve(whole, "../")

        try {
            fs.mkdirSync(parent, { recursive: true })
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

    read_file(tunnel: Tunnel, context: any) {

        const whole = this.prepare(context)
        const stream = fs.createReadStream(whole)

        stream.pipe(tunnel)
        stream.on("error", () => {
            stream.close()
            tunnel.destroy()
        })
        tunnel.on("end", () => {
            stream.close()
            tunnel.destroy()
        })
        console.log("writing to", whole)
    }

    prepare(context: any) {
        let whole: string = ""
        if (context.dest?.path) {
            whole = path.resolve(this.options.root, context.dest?.path)
        }
        else if (this.options.path) {
            whole = path.resolve(this.options.root, this.options.path)
        }
        else {
            whole = path.resolve(this.options.root, Date.now().toString())
        }

        return whole
    }
}