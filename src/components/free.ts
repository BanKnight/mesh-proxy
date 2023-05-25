import * as dgram from 'dgram';
import { Socket, createConnection } from "net";
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import { read_address, write_address } from '../utils.js';

const temp = Buffer.alloc(255)
export default class Free extends Component {
    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() { }

    close(error?: Error) { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        const dest = context.dest

        switch (dest.protocol) {
            case "tcp":
                this.handle_tcp(tunnel, context, callback)
                break
            case "udp":
                this.handle_udp(tunnel, context, callback)
                break
            default:
                callback()
                tunnel.destroy(new Error(`unknown protocol type:${dest.protocol}`))
                break
        }
    }

    handle_tcp(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        if (this.options.debug) {
            console.log(this.name, "tcp try connect", context.dest.host, context.dest.port)
        }

        const socket = createConnection({
            ...context.dest,
            keepAlive: true,
            noDelay: true,
            timeout: 0,
        } as any)

        socket.on("connect", () => {
            if (this.options.debug) {
                console.log(this.name, "tcp connected", context.dest.host, context.dest.port)
            }

            callback(null, {
                local: {
                    address: socket.localAddress,
                    port: socket.localPort,
                    family: socket.localFamily,
                },
                remote: {
                    address: socket.remoteAddress,
                    port: socket.remoteAddress,
                    family: socket.remoteFamily,
                }

            })

            socket.pipe(tunnel).pipe(socket)
        })
        socket.on('end', () => {
            tunnel.end()
            // socket.destroy()

            console.log(this.name, "tcp end", context.dest.host, context.dest.port)
        });

        socket.on('close', (has_error) => {
            tunnel.end()
            socket.destroy()

            console.log(this.name, "tcp close", has_error, context.dest.host, context.dest.port)
        });

        socket.on("error", (error: Error) => {

            if (socket.readyState == "opening") {
                if (this.options.debug) {
                    console.log(this.name, "tcp connect failed", context.dest.host, context.dest.port)
                }
                callback(error)
            }

            tunnel.end()
            socket.destroy()
        })

        tunnel.on("data", (data) => {
            console.log(this.name, "tcp ==>", context.dest.host, context.dest.port, data.length)
        })

        socket.on("data", (data) => {
            console.log(this.name, "tcp <==", context.dest.host, context.dest.port, data.length)
        })
    }

    handle_udp(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        const should_connect = context.dest?.port != null && context.dest?.host != null

        if (this.options.debug && context.dest?.port) {
            console.log(this.name, "udp try connect", context.dest.host, context.dest.port)
        }

        let has_callbacked = false

        const socket = dgram.createSocket("udp4")

        socket.on("error", (error: Error) => {

            if (!has_callbacked) {
                callback(error)
            }

            socket.close()
            tunnel.end()
        })

        socket.on("close", () => {
            tunnel.end()
        })

        tunnel.on("error", () => {
            socket.close()
            tunnel.end()
        })

        tunnel.on("end", () => {
            socket.close()
            tunnel.end()
        })
        tunnel.on("close", () => {
            socket.close()
            tunnel.end()
        })

        if (should_connect) {   //指定了对端地址，那么所有的数据都是直接发送的

            socket.connect(context.dest.port, context.dest.host, () => {
                has_callbacked = true
                callback(null, socket.address())
            })

            tunnel.on("data", (buffer) => {
                socket.send(buffer)
            })

            socket.on("message", (buffer) => {
                tunnel.write(buffer)
            })
        }
        else //没有指定地址，那么地址就隐藏在 头部就是地址
        {
            const dest: any = {}

            tunnel.on("data", (buffer: Buffer) => {
                const offset = read_address(buffer, dest, 0, context.socks5 == true)
                if (dest.port) {
                    socket.send(buffer.subarray(offset), dest.port, dest.host)
                }
            })

            socket.on("message", (buffer, rinfo) => {
                const end = write_address(temp, rinfo, 0, context.socks5 == true)
                tunnel.write(temp.subarray(0, end))
                tunnel.write(buffer)
            })

            socket.bind(0, () =>   //绑定到本地的一个系统分配的地址，然后固化下来
            {
                has_callbacked = true
                callback(null, socket.address())
            })
        }
    }

}