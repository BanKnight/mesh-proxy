import { WebSocket, WebSocketServer, createWebSocketStream } from "ws"
import https from "https"
import http from "http"
import url from "url"
import { Component, ComponentOption, Tunnel } from "../types.js";
import { Duplex } from 'stream';
import { handle_upgrade, url_join, has_port } from "../utils.js";

const isSSL = /^https|wss/;
const upgradeHeader = /(^|,)\s*upgrade\s*($|,)/i
export default class Http extends Component {

    wsserver = new WebSocketServer({ noServer: true })

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        if (this.options.port == null) {
            this.options.target = url.parse(this.options.target)
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

            this.connect_remote(location.pass, {
                method: req.method,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                url: req.url,
                httpVersion: req.httpVersion,
                httpVersionMajor: req.httpVersionMajor,
                httpVersionMinor: req.httpVersionMinor,
                socket: {
                    remoteAddress: req.socket.remoteAddress,
                    remotePort: req.socket.remotePort,
                }

            }, null, (error: Error | undefined, tunnel: Tunnel | undefined, resp: any) => {
                // // 组装 HTTP 请求头和正文
                // const requestData = `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
                // // 将 HTTP 请求头和正文发送给远端服务器
                // tunnel.write(requestData);

                if (error) {
                    req.destroy()
                    return
                }

                if (!res.headersSent) {
                    for (let name in resp.headers) {
                        let val = resp.headers[name]
                        res.setHeader(name, val)
                    }
                    res.writeHead(resp.statusCode, resp.statusMessage)
                }

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


                req.on("end", () => {
                    console.log("req end")
                })

                req.pipe(tunnel).pipe(res)
                tunnel.pipe(res);
            })
        }
    }

    make_ws_pass(path: string, location: any) {

        return (req: http.IncomingMessage, res: http.ServerResponse) => {

            this.connect_remote(location.pass, {
                protocol: "http",
                ssl: this.options.ssl,
                upgrade: "websocket",
                method: req.method,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                url: req.url,
                address: req.socket.remoteAddress,
                port: req.socket.remotePort,
            }, null, (error: Error | undefined, tunnel?: Tunnel) => {

                this.wsserver.handleUpgrade(req, req.socket, Buffer.alloc(0), (socket: WebSocket, req) => {

                    const duplex = createWebSocketStream(socket)

                    duplex.pipe(tunnel).pipe(duplex)

                    // 连接到远端服务器，并发起 HTTP 请求
                    tunnel.on("error", (reason) => {
                        // socket.destroy(reason)
                        tunnel.destroy(reason)
                    })
                })

            })

        }
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

    async connection(tunnel: Tunnel, source: any) {

        if (source.upgrade == "websocket") {
            return this.pass_websocket(tunnel, source)
        }
        else {
            return this.pass_request(tunnel, source)
        }
    }

    pass_websocket(tunnel: Tunnel, source: any) {

    }

    async pass_request(tunnel: Tunnel, source: any) {

        if (this.options.forward) {
            // If forward enable, so just pipe the request
            const forwardReq = (this.options.forward.protocol === 'https:' ? https : http).request(
                this.req_options(source, "forward")
            );

            // error handler (e.g. ECONNRESET, ECONNREFUSED)
            // Handle errors on incoming request as well as it makes sense to
            const forwardError = forwardReq.destroy.bind(forwardReq)

            tunnel.on('error', forwardError);
            forwardReq.on('error', forwardError);

            (this.options.buffer || source).pipe(forwardReq);
            if (!this.options.target) { return tunnel.end(); }
        }

        const outoptions = this.req_options(source)

        return new Promise((resolve, reject) => {

            const proxyReq = (this.options.target.protocol === 'https:' ? https : http).request(outoptions, (proxyRes) => {

                if (tunnel.writableFinished) {
                    resolve(null)
                    return
                }

                resolve({
                    httpVersion: proxyRes.httpVersion,
                    statusCode: proxyRes.statusCode,
                    statusMessage: proxyRes.statusMessage,
                    rawHeaders: proxyRes.rawHeaders,
                    headers: proxyRes.headers,
                })

                proxyRes.pipe(tunnel);
            });

            // allow outgoing socket to timeout so that we could
            // show an error page at the initial request
            if (this.options.proxyTimeout) {
                proxyReq.setTimeout(this.options.proxyTimeout, function () {
                    proxyReq.destroy();
                });
            }
            // Ensure we abort proxy if request is aborted
            const destroy_handler = proxyReq.destroy.bind(proxyReq)

            tunnel.on('close', destroy_handler);
            tunnel.on('error', destroy_handler);

            tunnel.pipe(proxyReq);

            proxyReq.on('error', console.error);
        })
    }

    req_options(req: any, forward?: string) {

        const outoptions = { ...this.options.ssl }
        const target = this.options[forward || 'target'];

        outoptions.port = this.options.target.port

        for (const name of ['host', 'hostname', 'socketPath', 'pfx', 'key',
            'passphrase', 'cert', 'ca', 'ciphers', 'secureProtocol']) {
            outoptions[name] = target[name];
        }

        outoptions.method = this.options.method || req.method
        outoptions.headers = { ...req.headers }

        if (this.options.headers) {
            Object.assign(outoptions.headers, this.options.headers)
        }

        if (this.options.auth) {
            outoptions.auth = this.options.auth
        }

        if (this.options.ca) {
            outoptions.ca = this.options.ca
        }

        if (isSSL.test(target.protocol)) {
            outoptions.rejectUnauthorized = (typeof this.options.secure === "undefined") ? true : this.options.secure;
        }

        outoptions.agent = this.options.agent || false;
        outoptions.localAddress = this.options.localAddress;

        if (!outoptions.agent) {
            outoptions.headers = outoptions.headers || {};
            if (typeof outoptions.headers.connection !== 'string'
                || !upgradeHeader.test(outoptions.headers.connection)
            ) {
                outoptions.headers.connection = 'close';
            }
        }

        const targetPath = this.options.prependPath !== false ?
            (target.path || '') : '';

        let outgoingPath = !this.options.toProxy
            ? (url.parse(req.url).path || '')
            : req.url;

        //
        // Remark: ignorePath will just straight up ignore whatever the request's
        // path is. This can be labeled as FOOT-GUN material if you do not know what
        // you are doing and are using conflicting options.
        //
        outgoingPath = !this.options.ignorePath ? outgoingPath : '';

        outoptions.path = url_join(targetPath, outgoingPath);

        if (this.options.changeOrigin) {

            const port_exists = has_port(outoptions.host)

            if (port_exists == false) {
                if (target.protocol == "http" && outoptions.port != 80) {
                    outoptions.headers.host = outoptions.host + ':' + outoptions.port
                }
                else if (target.protocol == "https" && outoptions.port != 443) {
                    outoptions.headers.host = outoptions.host + ':' + outoptions.port
                }
                else {
                    outoptions.headers.host = outoptions.host
                }
            }
        }

        return outoptions
    }
}
