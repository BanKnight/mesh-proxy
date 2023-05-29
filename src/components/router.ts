import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import fs from "fs"
import path from "path"
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
                const [ip, mask] = one.cond.split("/")
                one.ip = ip.split(".").map((item: string) => { parseInt(item) })
                one.mask = mask.split(".").map((item: string) => { parseInt(item) })
            }
            else if (one.type == "eval") {
                one.check = new Function("source", "dest", one.cond)
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
                case "domain": next_pass = this.check_domain(context, one); break;
                case "reg": next_pass = this.check_reg(context, one); break;
                case "eval": next_pass = this.check_eval(context, one); break;
            }
        }

        next_pass = next_pass || this.options.default

        if (next_pass == null) {
            tunnel.destroy(new Error(`no route to fit:${context.dest.host}`))
            return
        }

        const next = this.createConnection(this.options.pass, context, callback)

        tunnel.pipe(next).pipe(tunnel)

        next.on("error", (e) => {
            tunnel.destroy(e)
            next.destroy()
        })

        tunnel.on("error", () => {
            tunnel.destroy()
            next.destroy()
        })
    }

    check_ip(context: ConnectionContext, option: { ip: [number, number, number, number], mask: [number, number, number, number], pass: string }) {

        if (context.dest.family == null || context.dest.family == "IPv6") {
            return
        }

        const array = (context.dest.host.split(".").map((item: string) => { parseInt(item) })) as unknown as [number, number, number, number]
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

        return option.pass
    }

    check_domain(context: ConnectionContext, option: { cond: string, pass: string }) {

        if (context.dest.host == option.cond) {
            return option.pass
        }
    }

    check_reg(context: ConnectionContext, option: { reg: RegExp, pass: string }) {
        if (option.reg.test(context.dest.host)) {
            return option.pass
        }
    }

    check_eval(context: ConnectionContext, option: { check: Function, pass: string }) {
        if (option.check(context.source, context.dest)) {
            return option.pass
        }
    }
}