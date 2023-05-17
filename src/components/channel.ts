import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Channel extends Component {
    id: number = 0

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        this.on("connection", (tunnel: Tunnel, ...args: any[]) => {

            if (this.options.show == true) {
                tunnel.on("data", (data) => {
                    data = data.toString("utf-8")
                    console.log("==>", data)
                })
            }

            if (this.options.pass == null) {

                tunnel.on("error", () => {
                    tunnel.destroy()
                })

                return
            }

            const remote = this.create_tunnel()

            tunnel.pipe(remote)
            remote.pipe(tunnel)

            function destroy() {
                tunnel.destroy()
                remote.destroy()
            }

            tunnel.on("error", destroy)
            tunnel.on("close", destroy)
            remote.on("error", destroy)
            remote.on("close", destroy)

            return new Promise((resolve) => {
                remote.connect(this.options.pass, ...args, resolve)
            })
        })
    }

    close() {

    }
}