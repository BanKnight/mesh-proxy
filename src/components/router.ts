import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";


const isIP = /^([\d.-]+)\.([a-fA-F0-9]{1,4}\.)+[a-fA-F0-9]{1,4}$/;

export default class Router extends Component {

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {
        if (this.options.passes == null || this.options.passes.length == 0) {
            console.error(this.name, "passes is empty")
            return
        }

        for (let one of this.options.passes) {
            if (one.type == "reg") {
                one.reg = new RegExp(one.cond)
            }
            else if (one.type == "ip") {
                const [ip, mask] = one.cond.split("/") as [string, string]
                one.ip = ip.split(".").map((item: string) => { return parseInt(item) })
                one.mask = mask.split(".").map((item: string) => { return parseInt(item) })
            }
            else if (one.type == "eval") {
                one.eval = new Function("source", "dest", one.cond)
            }
            else if (one.type == "strict") {
                one.strict = one.cond.split(",")
            }
        }

    }
    close() { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        let next_pass = null

        for (let i = 0; i < this.options.passes.length && next_pass == null; ++i) {
            const one = this.options.passes[i]
            switch (one.type) {
                case "ip": next_pass = this.check_ip(context, one); break;
                case "strict": next_pass = this.check_strict(context, one); break;
                case "reg": next_pass = this.check_reg(context, one); break;
                case "eval": next_pass = this.check_eval(context, one); break;
            }
        }

        next_pass = next_pass || this.options.default

        if (next_pass == null) {
            tunnel.destroy(new Error(`no route to fit:${context.dest.host}`))
            return
        }

        const next = this.createConnection(next_pass, context, callback)

        tunnel.pipe(next).pipe(tunnel)

        next.on("error", (e) => {
            tunnel.destroy(e)
            next.destroy()
        })

        tunnel.on("error", () => {
            tunnel.destroy()
            next.destroy()
        })

        tunnel.on("close", () => {
            console.log("tunnel is closed")
            next.emit("close") 		//emitted when the connection is closed by the server.  (probably)
        })
    }

    check_ip(context: ConnectionContext, option: { ip: [number, number, number, number], mask: [number, number, number, number], pass: string, tag?: string }) {
        if (isIP.test(context.dest.host) == false) {
            return
        }

        const array = (context.dest.host.split(".").map((item: string) => { return parseInt(item) })) as unknown as [number, number, number, number]
        if (array.length != option.ip.length) {
            return
        }

        for (let i = 0; i < array.length; ++i) {
            let left = array[i]
            let right = option.ip[i]
            let mask = option.mask[i]

            let first = left & mask
            let second = right & mask

            if (first != second) {
                return
            }
        }

        if (option.tag) {
            context.dest.tag = option.tag
        }
        return option.pass
    }

    check_strict(context: ConnectionContext, option: { strict: string[], pass: string, tag?: string }) {

        if (!option.strict.includes(context.dest.host)) {
            return
        }

        if (option.tag) {
            context.dest.tag = option.tag
        }
        return option.pass
    }

    check_reg(context: ConnectionContext, option: { reg: RegExp, pass: string }) {
        if (option.reg.test(context.dest.host)) {
            return option.pass
        }
    }

    check_eval(context: ConnectionContext, option: { eval: Function, pass: string, tag?: string }) {
        if (!option.eval(context.src, context.dest)) {
            return
        }

        if (option.tag) {
            context.dest.tag = option.tag
        }
        return option.pass
    }
}