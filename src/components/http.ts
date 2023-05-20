import { WebSocket, WebSocketServer, createWebSocketStream } from "ws"
import https from "https"
import http from "http"
import url from "url"
import { Component, ComponentOption, SiteInfo, Tunnel } from "../types.js";
import { url_join, has_port } from "../utils.js";
import { Duplex } from "stream";

const isSSL = /^https|wss/;
const upgradeHeader = /(^|,)\s*upgrade\s*($|,)/i
export default class Http extends Component {

    wsserver = new WebSocketServer({ noServer: true })
    site?: SiteInfo;
    sockets: Record<string, Duplex> = {}

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
            ...this.options.listen,
            host: this.options.host,
            port: this.options.port,
            ssl: this.options.ssl,
        })

        for (let path in this.options.locations) {

            const location = this.options.locations[path]

            if (location.upgrade) {
                const cb = this.make_ws_pass(path, location)
                site.upgrades.set(path, cb)
            }
            else {
                const cb = this.make_req_pass(path, location)
                site.locations.set(path, cb)
            }
        }
    }

    close() {

        if (this.site == null) {
            return
        }

        for (let path in this.options.locations) {

            const location = this.options.locations[path]

            if (location.upgrade) {
                this.site.upgrades.delete(path)
            }
            else {
                this.site.locations.delete(path)
            }
        }
    }

    make_req_pass(path: string, location: any) {
        return (req: http.IncomingMessage, res: http.ServerResponse) => {

            const context = {
                source: {
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

            req.pipe(tunnel).pipe(res)

            tunnel.once("error", (e) => {
                if (!res.headersSent) {
                    res.writeHead(502, e.message)
                    res.end()
                }
            })
        }
    }

    make_ws_pass(path: string, location: any) {

        return (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {

            const context = {
                source: {
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
                    },
                }
            }

            if (head.length > 0) {
                socket.unshift(head)
            }

            const tunnel = this.createConnection(location.pass, context)

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(0)

            socket.pipe(tunnel).pipe(socket)

            socket.on("close", () => {
                tunnel.end()
            })
        }
    }

    connection(tunnel: Tunnel, context: any, callback: (...args: any[]) => void) {

        if (context.source.upgrade == "websocket") {
            return this.pass_websocket(tunnel, context, callback)
        }
        else {
            return this.pass_request(tunnel, context, callback)
        }
    }

    pass_request(tunnel: Tunnel, context: any, callback: (...args: any[]) => void) {

        const source = context.source

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
        const proxyReq = (this.options.target.protocol === 'https:' ? https : http).request(outoptions, (proxyRes) => {

            callback(null, {        //这里可以修改头部
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

    pass_websocket(tunnel: Tunnel, context: any, callback: (...args: any[]) => void) {

        callback()

        const source = context.source
        const outoptions = this.req_options(source)
        const proxyReq = (this.options.target.protocol === 'https:' ? https : http).request(outoptions);

        let upgrade = false
        let end = tunnel.end.bind(tunnel)

        proxyReq.on("error", end)
        proxyReq.on('upgrade', function (proxyRes, proxySocket, proxyHead) {

            upgrade = true
            proxySocket.on('error', end);

            tunnel.on('error', function () {
                proxySocket.end();
            });

            proxySocket.setKeepAlive(true)
            proxySocket.setNoDelay(true)
            proxySocket.setTimeout(0)

            if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);


            // 组装 HTTP 请求头和正文
            const requestData = `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
            // 将 HTTP 请求头和正文发送给远端服务器
            tunnel.write(requestData);

            proxySocket.pipe(tunnel).pipe(proxySocket)
        });

        proxyReq.on('response', function (res) {
            if (upgrade) {
                return
            }
            const requestData = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
            tunnel.write(requestData);
            res.pipe(tunnel);
        });

        proxyReq.end()          //只有这样才会发起请求
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
