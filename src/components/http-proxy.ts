import https from "https"
import http from "http"

import { Component, ComponentOption, Tunnel } from "../types.js";

export default class HttpProxy extends Component {
    id: number = 0

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        this.on("connection", (tunnel: Tunnel, req: any) => {

            this.delete_length(tunnel, req)
            this.change_headers(tunnel, req)

            this.stream(tunnel, req)
        })
    }

    close() {

    }

    delete_length(tunnel: Tunnel, req: any) {
        if ((req.method === 'DELETE' ||
            req.method === 'OPTIONS') &&
            !req.headers['content-length']) {

            req.headers['content-length'] = '0';
            delete req.headers['transfer-encoding'];
        }
    }

    change_headers(tunnel: Tunnel, req: any) {

    }

    stream(tunnel: Tunnel, req: http.RequestOptions | https.RequestOptions) {

        const options = this.options
        const proxy = (options.target.protocol == "https:" ? https : http).request({ method: req.method, headers: req.headers })

    }
}