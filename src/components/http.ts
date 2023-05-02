import url from 'url';
import { Component, ComponentOption } from "../types.js";
import http from 'http';
import * as ws from "ws"

export default class Http extends Component {

    server: http.Server;
    wss: ws.WebSocketServer

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        this.wss = new ws.WebSocketServer({ noServer: true })

        this.server = http.createServer((req, res) => {

            const site = this.options.sites[req.headers.host]
            if (site == null) {
                res.writeHead(404);
                res.end();
                return;
            }

            this.before_proxy(req)

            const is_websocket = req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket';
            if (is_websocket) {
                this.ws_proxy(req, res, site)
                return
            }

            this.request_proxy(req, res, site)
        })

        this.server.listen(this.options.port)

        console.log("http listening:", this.options.port)
    }

    close() {
        this.wss.close()
        this.server.close()
    }

    before_proxy(req: http.IncomingMessage) {
        req.headers['x-forwarded-for'] = req.socket.remoteAddress
    }

    async request_proxy(req: http.IncomingMessage, res: http.ServerResponse, site: any) {

        console.log(`收到 HTTP 请求：${req.method} ${req.url}==>`, site);

        // 连接到远端服务器，并发起 HTTP 请求
        const tunnel = this.node.create_tunnel()

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

        tunnel.connect(site.pass, () => {

            // 组装 HTTP 请求头和正文
            const requestData = `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
            // 将 HTTP 请求头和正文发送给远端服务器
            tunnel.write(requestData);

            req.pipe(tunnel);
            tunnel.pipe(res);
        })

        // // 处理从远端服务器收到数据的事件
        // tunnel.on('data', (data) => {
        //     // 将远端服务器的响应头和正文分离出来
        //     const [responseHeader, responseBody] = data.toString().split('\r\n\r\n');
        //     // 将响应头发送给客户端
        //     const [responseStatusLine, ...responseHeaders] = responseHeader.split('\r\n');
        //     const [_, responseStatusCode, responseStatusText] = responseStatusLine.split(' ');
        //     res.writeHead(responseStatusCode, responseStatusText, responseHeaders);
        //     // 将响应正文发送给客户端
        //     res.write(responseBody);
        //     // 关闭 socket 连接和响应
        //     tunnel.end();
        //     res.end();
        // });
        // // 处理 socket 连接关闭的事件
        // tunnel.on('close', () => {
        //     console.log('连接已关闭');
        // });
    }
    ws_proxy(req: http.IncomingMessage, res: http.ServerResponse, site: any) {

        this.wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (socket) => {

            // 连接到远端服务器，并发起 HTTP 请求
            const tunnel = this.node.create_tunnel()

            tunnel.connect(site.pass, () => { })

            socket.on('message', msg => tunnel.write(msg));

            tunnel.on('data', data => socket.send(data, err => err && socket.close()));
        });
    };
}