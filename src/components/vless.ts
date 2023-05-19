import { stringify } from "uuid"
import { Component, ComponentOption, CachedTunnel, Tunnel, ConnectListener } from "../types.js";

const resp = Buffer.from([0, 0])
export default class Vless extends Component {

    users = new Map<string, any>

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {
        if (this.options.passes == null) {
            this.emit("error", new Error("no pass defined in the options"))
        }
        for (const user of this.options.users) {
            this.users.set(user.id, user)
        }
    }
    close() { }

    //https://github.com/v2ray/v2ray-core/issues/2636
    // 1 字节	  16 字节       1 字节	       M 字节	              1 字节            2 字节      1 字节	      S 字节	      X 字节
    // 协议版本	  等价 UUID	  附加信息长度 M	(附加信息 ProtoBuf)  指令(udp/tcp)	    端口	      地址类型      地址	        请求数据
    // 00                   00                                  01                 01bb(443)   02(ip/host)
    // 1 字节	              1 字节	      N 字节	         Y 字节
    // 协议版本，与请求的一致	附加信息长度 N	附加信息 ProtoBuf	响应数据
    connection(tunnel: CachedTunnel, context: any, callback: ConnectListener) {

        callback()

        tunnel.next = this.head.bind(this, tunnel, context)
        tunnel.on("data", (buffer: Buffer) => {
            if (tunnel.pendings == null) {
                tunnel.pendings = buffer
            }
            else {
                buffer.copy(tunnel.pendings, tunnel.pendings.length)
            }
            tunnel.next()
        })
    }

    head(tunnel: CachedTunnel, context: any) {

        const buffer = tunnel.pendings

        if (buffer.length < 24) {
            return
        }

        let offset = 0

        const version = buffer[offset++]
        const userid = stringify(buffer.subarray(offset, offset += 16))     //1,17

        const optLength = buffer[offset++]      //17
        const cmd = buffer[offset += optLength] //18+optLength

        const dest = {
            host: "",
            protocol: "tcp",
            port: 0
        }

        dest.port = buffer.readUInt16BE(++offset) as unknown as number

        offset += 2

        const address_type = buffer[offset++]
        switch (address_type) {
            case 0x01:      //ipv4
                {
                    dest.host = `${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}`
                }
                break
            case 0x02:      //domain
                {
                    const size = buffer[offset++]
                    dest.host = buffer.subarray(offset, offset += size).toString()
                }
                break
            case 0x03:      //ipv6
                {
                    const address = []

                    for (let i = 0; i < 8; i++) {
                        address.push(buffer.readUint16BE(offset += 2).toString(16));
                    }
                    dest.host = address.join(":")
                }
                break
            default:
                tunnel.destroy(new Error(`invild  addressType is ${address_type}`))
                return
        }

        tunnel.pendings = null
        tunnel.removeAllListeners("data")

        const source = context.source = Object.assign(context.source || {}, { user: userid, version })

        if (this.auth(tunnel, context.source, context.dest) == false) {
            const e = new Error(`component[${this.name}]:auth failed from ${source.socket?.remoteAddress}:${source.socket?.remotePort},userid:${userid}`)
            console.error(e)
            tunnel.destroy(e)
            return
        }

        const head = buffer.subarray(offset)

        switch (cmd) {
            case 0x01:      //tcp
                dest.protocol = "tcp"
                this.tcp(tunnel, context, head)
                break
            case 0x02:      //udp
                dest.protocol = "udp"
                this.udp(tunnel, context, head)
                break
            case 0x03:      //mux
                this.mux(tunnel, context, head)
                break
            default:
                tunnel.destroy(new Error(`unsupported type:${cmd}`))
                break
        }
    }

    auth(tunnel: Tunnel, source: any, dest: any) {

        if (this.users.size == 0) {
            return true
        }

        const exists = this.users.get(source.user)
        if (exists == null) {
            return false
        }

        return true
    }
    tcp(tunnel: Tunnel, context: any, head: Buffer) {

        const pass = this.options.passes.tcp

        if (pass == null) {
            tunnel.destroy(new Error(`no tcp pass`))
            return
        }

        const next = this.createConnection(pass, context, () => {

            tunnel.write(resp)

            if (head.length > 0) {
                next.write(head)
            }

            tunnel.pipe(next).pipe(tunnel)
        })

        next.once("error", (e) => {
            next.destroy()
            tunnel.destroy(e)
        })
    }

    udp(tunnel: Tunnel, context: any, head: Buffer) {

    }

    mux(tunnel: Tunnel, context: any, head: Buffer) {

    }
}