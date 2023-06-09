import { WebSocket, WebSocketServer, createWebSocketStream } from "ws"
import https from "https"
import http from "http"
import url, { UrlWithStringQuery } from "url"
import { Component, ComponentOption, SiteInfo, Tunnel, Location, ConnectionContext, ConnectListener } from "../types.js";
import { url_join, has_port } from "../utils.js";
import { Duplex, finished } from "stream";

const isSSL = /^https|wss/;
const upgradeHeader = /(^|,)\s*upgrade\s*($|,)/i
export default class Http extends Component {

    wsserver = new WebSocketServer({ noServer: true })
    site?: SiteInfo;

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        if (this.options.url) {
            this.options.address = url.parse(this.options.url)
            this.on("connection", this.connection.bind(this))
            return
        }

        const site = this.create_site({
            ...this.options.listen,
            host: this.options.host,
            port: this.options.port,
            ssl: this.options.ssl,
        })

        for (let path in this.options.locations) {
            const location = this.options.locations[path]

            let cb = null

            if (location.upgrade) {
                cb = this.handle_upgrade.bind(this, location)
            }
            else {
                cb = this.handle_request.bind(this, location)
            }

            site.locations.set(path, {
                callback: cb,
                upgrade: location.upgrade
            })
        }
    }

    close() {
        if (this.site == null) {
            return
        }

        for (let path in this.options.locations) {
            this.site.locations.delete(path)
        }
    }
    handle_request(location: any, req: http.IncomingMessage, res: http.ServerResponse) {

        // const outoptions = this.req_options(req)
        const context: ConnectionContext = {
            src: {
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
                    family: req.socket.remoteFamily,
                    protocol: "http"
                },
                // ...outoptions
            }
        }
        const tunnel = this.createConnection(location.pass, context, (resp: any) => {
            if (!res.headersSent) {
                for (let name in resp.headers) {
                    let val = resp.headers[name]
                    res.setHeader(name, val)
                }
                res.writeHead(resp.statusCode, resp.statusMessage)
            }
        })

        if (tunnel == null) {
            if (!res.headersSent) {
                res.writeHead(502, "Bad gateway")
                res.end()
            }
            return
        }

        req.pipe(tunnel).pipe(res)

        finished(req, () => {
            if (!tunnel.destroyed) {
                tunnel.destroy()
            }
        })

        finished(tunnel, (error?: Error) => {
            if (error) {
                if (!res.headersSent) {
                    res.writeHead(500, error.message)
                    res.end()
                }
            }
            if (!tunnel.destroyed) {
                tunnel.destroy()
            }
        })
    }

    handle_upgrade(location: Location, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
        this.wsserver.handleUpgrade(req, socket, head, (wsocket: WebSocket) => {
            const context: ConnectionContext = {
                src: {
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
                        localAddress: req.socket.localAddress,
                        localPort: req.socket.localPort,
                        localFamily: req.socket.localFamily,
                        family: req.socket.remoteFamily,
                    },
                    host: req.socket.remoteAddress,
                    port: req.socket.remotePort,
                    family: req.socket.remoteFamily as "IPv4" | "IPv6",
                }
            }
            const stream = createWebSocketStream(wsocket, location as unknown)
            const tunnel = this.createConnection(location.pass, context)

            if (tunnel == null) {
                stream.destroy()
                return
            }

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(0)

            stream.pipe(tunnel).pipe(stream)
            stream.on("close", () => {
                tunnel.end()
            })
            tunnel.on("error", () => {
                tunnel.end()
                stream.destroy()
            })

            stream.on("error", () => {
                tunnel.end()
                stream.destroy()
            })
        })
    }
    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {
        if (this.options.address == null) {
            tunnel.destroy(new Error("no address"))
            return
        }
        const address = this.options.address as UrlWithStringQuery
        if (address.protocol == "http:" || address.protocol == "https:") {
            return this.pass_request(tunnel, context, callback)
        }
        return this.pass_websocket(tunnel, context, callback)
    }
    pass_request(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        const outoptions = this.req_options(context.src)
        const target = this.options.address
        const proxyReq = (target.protocol === 'https:' ? https : http).request(outoptions, (proxyRes) => {
            callback({        //这里可以修改头部
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
        const done = proxyReq.end.bind(proxyReq)

        tunnel.on('close', done);
        tunnel.on('error', done);
        tunnel.pipe(proxyReq);

        proxyReq.once('error', () => {
            if (!proxyReq.headersSent) {
                tunnel.end()
            }
        });
        // proxyReq.end()
    }

    pass_websocket(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        callback()

        const wsocket = new WebSocket(this.options.url, this.options as unknown)
        const stream = createWebSocketStream(wsocket)

        stream.on("error", () => {
            tunnel.end()
            stream.destroy()
        })
        stream.on("close", () => {
            tunnel.end()
        })
        tunnel.on("error", () => {
            stream.destroy()
            tunnel.end()
        })
        tunnel.pipe(stream).pipe(tunnel)
    }

    req_options(req: any, forward?: string) {

        const outoptions = { ...this.options.ssl }
        const target = this.options[forward || 'address'];

        outoptions.port = target.port

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
