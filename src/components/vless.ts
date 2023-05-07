import { stringify } from "uuid"
import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Vless extends Component {

    users = new Set<string>()

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
        for (const userid of this.options.users) {
            this.users.add(userid)
        }
    }
    close() { }

    //https://github.com/v2ray/v2ray-core/issues/2636
    // 1 字节	  16 字节       1 字节	       M 字节	              1 字节            2 字节      1 字节	      S 字节	      X 字节
    // 协议版本	  等价 UUID	  附加信息长度 M	(附加信息 ProtoBuf)  指令(udp/tcp)	    端口	      地址类型      地址	        请求数据
    // 00                   00                                  01                 01bb(443)   02(ip/host)
    // 1 字节	              1 字节	      N 字节	         Y 字节
    // 协议版本，与请求的一致	附加信息长度 N	附加信息 ProtoBuf	响应数据
    connection<T extends Tunnel & { pendings?: Buffer }>(tunnel: T, source: any) {

        const on_head = (buffer: Buffer) => {

            if (tunnel.pendings == null) {
                tunnel.pendings = buffer
            }
            else {
                buffer.copy(tunnel.pendings, tunnel.pendings.length)
            }

            if (tunnel.pendings.length < 24) {
                return
            }

            buffer = tunnel.pendings

            let offset = 0

            const version = buffer[offset++]
            const userid = stringify(buffer.subarray(offset, offset += 16))     //1,17

            const optLength = buffer[offset++]      //17
            const cmd = buffer[offset += optLength] //18+optLength

            const dest = {
                address: "",
                port: 0
            }

            dest.port = buffer.readUInt16BE(++offset) as unknown as number

            const address_type = buffer[offset++]
            switch (address_type) {
                case 0x01:      //ipv4
                    {
                        dest.address = `${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}`
                    }
                    break
                case 0x02:      //domain
                    {
                        const size = buffer[offset++]
                        dest.address = buffer.subarray(offset, offset += size).toString()
                    }
                    break
                case 0x03:      //ipv6
                    {
                        const address = []

                        for (let i = 0; i < 8; i++) {
                            address.push(buffer.readUint16BE(offset += 2).toString(16));
                        }
                        dest.address = address.join(":")
                    }
                    break
                default:
                    console.log(`invild  addressType is ${address_type}`);
                    tunnel.end()
                    return
            }

            tunnel.pendings = null
            tunnel.off("data", on_head)

            source = Object.assign({}, source, { user: userid, version })

            this.auth(tunnel, source, dest)

            const head = buffer.subarray(offset)

            switch (cmd) {
                case 0x01:      //tcp
                    this.tcp(tunnel, source, dest, head)
                    break
                case 0x02:      //udp
                    this.udp(tunnel, source, dest, head)
                    break
                case 0x03:      //mux
                    this.mux(tunnel, source, dest, head)
                    break
            }

            const next = this.create_tunnel()

            tunnel.pipe(next)
            next.pipe(tunnel)

            function destroy() {
                tunnel.destroy()
                next.destroy()
            }

            tunnel.on("error", destroy)
            tunnel.on("close", destroy)
            next.on("error", destroy)
            next.on("close", destroy)

            next.connect(this.options.pass, source)

            next.send("target", {
                version,
                userid,
                dest,
                head: tunnel.pendings,
            })
        }

        tunnel.on("data", on_head)
    }

    auth(tunnel: Tunnel, source: any, dest: any) {

        if (this.users.size == 0) {
            return
        }

        if (this.users.has(source.user) == false) {
            console.error(`new such user:${source.user}`)
            tunnel.destroy()
            return
        }
    }
    tcp(tunnel: Tunnel, source: any, dest: any, head: Buffer) {

        const pass = this.options.passes.tcp

        if (pass == null) {
            tunnel.destroy(new Error(`no tcp pass`))
            return
        }

        const next = this.create_tunnel()

        tunnel.pipe(next)
        next.pipe(tunnel)

        next.connect(pass, () => {
            if (head.length > 0) {
                next.write(head)
            }
        })
    }

    udp(tunnel: Tunnel, source: any, dest: any, head: Buffer) {

    }

    mux(tunnel: Tunnel, source: any, dest: any, head: Buffer) {

    }
}