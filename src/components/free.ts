import * as dgram from 'dgram';
import { Socket, createConnection } from "net";
import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import { read_address, write_address } from '../utils.js';

let temp = Buffer.alloc(1024)
export default class Free extends Component {

    alive_tcp = 0
    alive_udp = 0; 					//number of alive udp connections
    timer: NodeJS.Timer;			//timer for keepalive messages

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {

        if (this.options.debug) {
            this.timer = setInterval(() => {
                console.log("alive_tcp:", this.alive_tcp)  //debugging purpose only
            }, 3000)
        }

    }

    close(error?: Error) {
        if (this.timer) {
            clearInterval(this.timer); 					//cancel the timer if it's set
        }
    }

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

        console.log(this.name, "tcp try connect", context.dest.host, context.dest.port)

        const socket = createConnection({
            ...context.dest,
            keepAlive: true,
            noDelay: true,
            timeout: 0,
        } as any, () => {

            this.alive_tcp++

            if (this.options.debug) {
                console.log(this.name, "tcp connected", context.dest.host, context.dest.port)
            }

            callback({
                local: {
                    address: socket.localAddress,
                    port: socket.localPort,
                    family: socket.localFamily,
                },
                remote: {
                    address: socket.remoteAddress,
                    port: socket.remotePort,
                    family: socket.remoteFamily,
                }

            })
        })

        socket.pipe(tunnel).pipe(socket)
        socket.on('end', () => {
            tunnel.end()
            // socket.destroy()
            if (this.options.debug) {
                console.log(this.name, "tcp end", context.dest.host, context.dest.port)
            }
        });

        socket.on('close', (has_error) => {
            tunnel.end()
            socket.destroy()

            this.alive_tcp--

            if (this.options.debug) {
                console.log(this.name, "tcp close", has_error, context.dest.host, context.dest.port)
            }
        });

        socket.on("error", (error: Error) => {
            if (socket.readyState == "opening") {
                console.log(this.name, "tcp connect failed", context.dest.host, context.dest.port)
            }

            tunnel.destroy()
            socket.destroy()
        })
    }

    handle_udp(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        const should_connect = context.dest?.port != null && context.dest?.host != null

        if (context.dest?.port) {
            console.log(this.name, "udp try connect", context.dest.host, context.dest.port)
        }

        const socket = dgram.createSocket("udp4")

        socket.on("error", (error: Error) => {
            tunnel.destroy(error)
            socket.disconnect()
        })

        socket.on("close", () => {
            tunnel.end()
        })

        tunnel.on("error", () => {
            tunnel.end()
            socket.disconnect()
        })

        tunnel.on("end", () => {
            tunnel.end()
            socket.disconnect()
        })
        tunnel.on("close", () => {
            tunnel.end()
            socket.disconnect()
        })

        if (should_connect) {   //指定了对端地址，那么所有的数据都是直接发送的

            socket.connect(context.dest.port, context.dest.host, () => {
                callback(socket.address())
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

                let offset = read_address(buffer, dest, 0, context.socks5 == true)
                dest.port = buffer.readUint16BE(offset)

                offset += 2
                socket.send(buffer.subarray(offset), dest.port, dest.host)
            })

            socket.on("message", (buffer, rinfo) => {

                const need_length = buffer.length + 7       // address_type(1) + address(4) + port(2)

                let curr = temp
                if (curr.length < need_length) {
                    curr = Buffer.allocUnsafe(need_length)
                }

                let offset = write_address(curr, rinfo, 0, context.socks5 == true)
                offset = curr.writeUint16BE(rinfo.port, offset)

                offset += buffer.copy(curr, offset)

                tunnel.write(curr.subarray(0, offset))
            })

            socket.bind(() =>   //绑定到本地的一个系统分配的地址，然后固化下来
            {
                callback(socket.address())
            })
        }
    }

}