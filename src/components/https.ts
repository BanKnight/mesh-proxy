
import * as https from 'https';
import * as tls from 'tls';

import { Component, ComponentOption } from "../types.js";
import * as ws from "ws"

export default class Http extends Component {

    server: https.Server;
    wss: ws.WebSocketServer

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
    }

    ready() {

        /**
         * secureConnection 和 SNICallback 都是与TLS（Transport Layer Security）相关的事件和方法，它们在创建安全服务器（HTTPS服务器）时起到不同的作用。 
        -  secureConnection 事件是在TLS握手完成后触发的。它可以让您检查TLS握手的结果以及客户端和服务器之间建立的安全连接。您可以在这个事件中对连接进行任何验证或处理，例如检查客户端证书或执行其他的安全检查。但是，这个事件不能帮助您决定使用哪个证书，因为握手已经完成了。 
        -  SNICallback 是一个TLS服务器选项，它允许服务器为不同的主机名使用不同的TLS证书。当客户端发送一个SNI（Server Name Indication）扩展名到服务器时，服务器可以使用 SNICallback 回调函数来选择相应的证书。这个回调函数会被调用，以与客户端通信的SNI主机名作为参数。
            回调函数返回一个和主机名对应的证书及密钥。如果没有为特定的主机名指定证书，则可以返回一个默认的证书及密钥。这样，服务器就可以在运行时使用不同的证书来保护多个网站或应用程序，而无需创建多个服务器实例。 
        
        在一些使用场景中，这两个事件可以结合使用。例如，您可以在 SNICallback 回调函数中选择适当的证书和密钥，然后在 secureConnection 事件中执行进一步的安全处理和验证，以确保连接是安全和可信的。
         */
        this.server = https.createServer({
            SNICallback: (servername, cb) => {
                const site = this.options.sites[servername]
                if (site) {
                    const context = tls.createSecureContext({ key: site.key, cert: site.cert });
                    cb(null, context);
                } else {
                    cb(new Error('No such server'));
                }
            }
        }, (req, res) => {

        })

        // this.server.on("connect")

        this.server.listen(this.options.port)
    }

    close() {
        this.server?.close()
    }
}
