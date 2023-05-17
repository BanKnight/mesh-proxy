import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Through extends Component {
    id: number = 0

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        this.on("connection", (tunnel: Tunnel, source: any, dest: any, callback: Function) => {

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

            this.connect_remote(this.options.pass, source, dest, (error: Error | null, remote?: Tunnel) => {

                callback(...arguments)

                if (error) {
                    return
                }

                tunnel.pipe(remote).pipe(tunnel)
            })
        })
    }

    close() {

    }
}