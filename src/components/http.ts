import https from "https"
import http from "http"
import * as ws from "ws"
import { Component, ComponentOption, Tunnel, WSocket } from "../types.js";
import { Duplex } from 'stream';

export default class Http extends Component {

    target: URL;

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        if (this.options.port == null) {

            this.target = new URL(this.options.pass.target)

            this.on("connection", this.connection.bind(this))
            return
        }

        const site = this.create_site({
            host: this.options.host,
            port: this.options.port,
            ssl: this.options.ssl,
        })

        for (let path in this.options.locations) {

            const location = this.options.locations[path]

            if (location.ws) {
                const cb = this.make_ws_pass(path, location)
                site.locations.set(path, cb)
            }
            else {
                const cb = this.make_req_pass(path, location)
                site.locations.set(path, cb)
            }
        }
    }

    close() { }

    make_req_pass(path: string, location: any) {
        return (req: http.IncomingMessage, res: http.ServerResponse) => {

            // 连接到远端服务器，并发起 HTTP 请求
            const tunnel = this.create_tunnel()

            // 处理 socket 连接过程中的错误
            tunnel.on('error', (e: Error) => {
                // console.error(`连接出错: ${e.message}`);
                req.destroy()
                tunnel.destroy()
            });

            tunnel.on('close', (e: Error) => {
                // console.error(`连接出错: ${e.message}`);
                req.destroy()
                tunnel.destroy()
            });

            req.on('error', (e: Error) => {
                // console.error(`连接出错: ${e.message}`);
                req.destroy()
                tunnel.destroy()
            });

            tunnel.on('close', (e: Error) => {
                // console.error(`连接出错: ${e.message}`);
                req.destroy()
                tunnel.destroy()
            });

            tunnel.connect(location.pass, {
                protocol: "http",
                ssl: this.options.ssl != null,
                method: req.method,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                url: req.url,
                address: req.socket.remoteAddress,
                port: req.socket.remotePort,
            }, () => {

                // 组装 HTTP 请求头和正文
                const requestData = `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
                // 将 HTTP 请求头和正文发送给远端服务器
                tunnel.write(requestData);

                req.pipe(tunnel);
                tunnel.pipe(res);
            })
        }
    }

    make_ws_pass(path: string, location: any) {

        const callback = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {

            // 连接到远端服务器，并发起 HTTP 请求
            const tunnel = this.create_tunnel()

            tunnel.connect(location.pass, {
                protocol: "http",
                ssl: this.options.ssl,
                upgrade: "websocket",
                method: req.method,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                url: req.url,
                address: req.socket.remoteAddress,
                port: req.socket.remotePort,
            }, () => {

                if (head && head.length > 0) {
                    socket.unshift(head)
                }
                this.on_new_socket(socket, tunnel)
            })

            tunnel.on("error", (reason) => {
                socket.destroy(reason)
                tunnel.destroy(reason)
            })
        }
        callback.ws = true
        return callback
    }

    on_new_socket(socket: Duplex, tunnel: Tunnel) {

        socket.pipe(tunnel)
        tunnel.pipe(socket)

        tunnel.on("error", () => {
            tunnel.destroy()
            socket.destroy()
        })

        tunnel.on("close", () => {
            tunnel.destroy()
            socket.destroy()
        })

        socket.on("error", () => {
            socket.destroy()
            tunnel.destroy()
        })

        socket.on("end", () => {
            tunnel.destroy()
            socket.destroy()
        })

        socket.on('close', (has_error) => { });
    }

    connection(tunnel: Tunnel, source: any) {

        if (source.upgrade == "websocket") {
            this.pass_websocket(tunnel, source)
        }
        else {
            this.pass_request(tunnel, source)
        }
    }

    pass_websocket(tunnel: Tunnel, source: any) {

    }

    pass_request(tunnel: Tunnel, source: any) {

    }
}