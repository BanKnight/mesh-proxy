import { finished } from "stream";
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import { isIPv4, BlockList } from "net"

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
            if (one.type == "address") {
                const blocklist = one.list = new BlockList()
                for (const address of one.cond.split(",")) {
                    blocklist.addAddress(address);
                }
            }
            else if (one.type == "range") {
                const blocklist = one.list = new BlockList()
                for (const range of one.cond.split(",")) {
                    const [start, stop] = range.split["-"]
                    blocklist.addRange(start, stop)
                }
            }
            else if (one.type == "subnet") {
                const blocklist = one.list = new BlockList()
                for (const subnet of one.cond.split(",")) {
                    const [net, prefix] = subnet.split["/"]
                    blocklist.addSubnet(net, Number(prefix))
                }
            }
            else if (one.type == "reg") {
                one.reg = new RegExp(one.cond)
            }
            else if (one.type == "eval") {
                one.eval = new Function("source", "dest", one.cond)
            }
        }

    }
    close() { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        let next_pass = null

        for (let i = 0; i < this.options.passes.length && next_pass == null; ++i) {
            const one = this.options.passes[i]
            switch (one.type) {
                case "reg": next_pass = this.check_reg(context, one); break;
                case "eval": next_pass = this.check_eval(context, one); break;
                default: next_pass = this.check_list(context, one); break;
            }
        }

        next_pass = next_pass || this.options.default

        if (next_pass == null) {
            tunnel.destroy(new Error(`no route to fit:${context.dest.host}`))
            return
        }

        const next = this.createConnection(next_pass, context, callback)

        if (next == null) {
            tunnel.destroy()
            return
        }

        tunnel.pipe(next).pipe(tunnel)

        const destroy = () => {
            if (!tunnel.destroyed) {
                tunnel.destroy()
            }
            if (!next.destroyed) {
                next.destroy()
            }
        }

        finished(next, destroy)
        finished(tunnel, destroy)
    }

    check_list(context: ConnectionContext, option: { list: BlockList, pass: string, tag?: string }) {

        if (!option.list.check(context.dest.host)) {
            return
        }

        if (isIPv4(context.dest.host) == false) {
            return
        }

        if (option.tag) {
            context.dest.tag = option.tag
        }
        return option.pass
    }

    check_reg(context: ConnectionContext, option: { reg: RegExp, pass: string, tag?: string }) {
        if (!option.reg.test(context.dest.host)) {
            return option.pass
        }

        if (option.tag) {
            context.dest.tag = option.tag
        }
        return option.pass
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