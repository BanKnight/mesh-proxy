import { stringify, v5, validate } from "uuid"
import { Component, ComponentOption, CachedTunnel, Tunnel, ConnectListener, ConnectionContext } from "../types.js";
import { read_address } from "../utils.js";

const vless_success_resp = Buffer.from([0, 0])
const protocol_type_to_name = {
    1: "tcp",
    2: "udp",
    3: "mux"
}

interface Session {
    id: string;
    meta: Buffer;
    protocol: "tcp" | "udp";
    port: number;
    host: string;
    tunnel?: Tunnel
}

export default class Vless extends Component {

    users = new Map<string, any>
    sessions: Record<string, Record<string, Session>> = {}

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {
        if (this.options.pass == null) {
            this.emit("error", new Error("no pass defined in the options"))
        }
        for (const user of this.options.users) {
            const uuid = validate(user.id) ? user.id : v5(user.id, Buffer.alloc(16))
            this.users.set(uuid, user)
        }
    }
    close() { }

    //https://github.com/v2ray/v2ray-core/issues/2636
    // 1 字节	  16 字节       1 字节	       M 字节	              1 字节            2 字节      1 字节	      S 字节	      X 字节
    // 协议版本	  等价 UUID	  附加信息长度 M	(附加信息 ProtoBuf)  指令(udp/tcp)	    端口	      地址类型      地址	        请求数据
    // 00                   00                                  01                 01bb(443)   02(ip/host)
    // 1 字节	              1 字节	      N 字节	         Y 字节
    // 协议版本，与请求的一致	附加信息长度 N	附加信息 ProtoBuf	响应数据
    connection(tunnel: CachedTunnel, context: ConnectionContext, callback: ConnectListener) {

        callback()

        // console.log("😀 recv new vless connection", tunnel.id)

        tunnel.pendings = []
        tunnel.write(vless_success_resp)      //回应
        tunnel.next = this.head.bind(this, tunnel, context)
        tunnel.on("data", (buffer: Buffer) => {
            tunnel.pendings.push(buffer)
            tunnel.next()
        })

        tunnel.on("end", () => {
            delete this.sessions[tunnel.id]
        })
    }

    fetch_all_pendins(tunnel: CachedTunnel, at_least_length: number) {

        let total = 0
        for (let one of tunnel.pendings) {
            total += one.length
        }
        if (total < at_least_length) {
            return
        }

        if (tunnel.pendings.length == 1) {
            return tunnel.pendings.pop()
        }
        const buffer = Buffer.allocUnsafe(total)

        let offset = 0

        while (tunnel.pendings.length > 0) {
            let one = tunnel.pendings.shift()
            one.copy(buffer, offset, one.length)
            offset += one.length
        }

        return buffer
    }

    head(tunnel: CachedTunnel, context: ConnectionContext) {

        const buffer = this.fetch_all_pendins(tunnel, 24)
        if (buffer == null) {
            return
        }

        let offset = 0

        const version = buffer[offset++]
        const userid = stringify(buffer.subarray(offset, offset += 16))     //1,17

        const optLength = buffer[offset++]      //17
        const optBuffer = buffer.subarray(offset, offset += optLength)
        const cmd = buffer[offset++] //18+optLength

        let protocol = protocol_type_to_name[cmd]
        if (protocol == null) {
            tunnel.destroy(new Error(`unsupported type:${cmd}`))
            return
        }

        const source = context.source

        if (this.auth(tunnel, context.source, userid) == false) {
            const e = new Error(`component[${this.name}]:auth failed from ${source.socket?.remoteAddress}:${source.socket?.remotePort},userid:${userid}`)
            console.error(e)
            tunnel.destroy(e)
            return
        }

        if (cmd == 3)        //mux
        {
            tunnel.pendings.push(buffer.subarray(offset))
            tunnel.next = this.mux.bind(this, tunnel, context)
            this.mux(tunnel, context)
            return
        }

        const dest = context.dest = {
            host: "",
            protocol,
            port: buffer.readUInt16BE(offset) as unknown as number,
            user: userid,
            version,
        }

        offset += 2

        offset = read_address(buffer, dest, offset)
        if (!dest.host) {
            tunnel.destroy(new Error(`invalid  addressType`))
            return
        }

        // tunnel.pendings = null
        tunnel.removeAllListeners("data")

        const head = buffer.subarray(offset)
        if (head.length > 0) {
            tunnel.unshift(head)
        }

        switch (cmd) {
            case 0x01:      //tcp
                this.tcp(tunnel, context)
                break
            case 0x02:      //udp
                this.udp(tunnel, context)
                break
            default:
                tunnel.destroy(new Error(`unsupported type:${cmd}`))
                break
        }
    }

    auth(tunnel: Tunnel, source: any, userid: string) {
        if (this.users.size == 0) {
            return true
        }

        const exists = this.users.get(userid)
        if (exists == null) {
            return false
        }
        return true
    }

    tcp(tunnel: Tunnel, context: ConnectionContext) {

        const pass = this.options.pass
        if (pass == null) {
            tunnel.destroy(new Error(`no next pass`))
            return
        }

        const next = this.createConnection(pass, context)

        // tunnel.write(vless_success_resp)      //回应
        // tunnel.unshift(head)
        tunnel.pipe(next).pipe(tunnel)
        tunnel.on("close", () => {
            next.end()
            tunnel.end()
        })
        next.on("end", () => {
            next.end()
            tunnel.end()
        })
        next.on("error", (e) => {
            next.end()
            tunnel.end()
        })
    }

    udp(tunnel: Tunnel, context: ConnectionContext) {
        this.tcp(tunnel, context)
    }
    mux(tunnel: CachedTunnel, context: ConnectionContext) {

        const buffer = this.fetch_all_pendins(tunnel, 2 + 2 + 1 + 1)
        if (buffer == null) {
            return
        }
        const meta_length = buffer.readUInt16BE()

        if (meta_length < 4) {
            tunnel.destroy()
            return
        }

        if (2 + meta_length > buffer.length) {      //没有收全
            tunnel.pendings.push(buffer)
            return
        }

        const meta = buffer.subarray(2, 2 + meta_length)
        const type = meta[2]

        const has_extra = meta[3] == 1

        const extra_length_start = 2 + meta_length
        const extra_length = has_extra ? buffer.readUInt16BE(extra_length_start) : 0

        if (has_extra && extra_length_start + 2 + extra_length > buffer.length) {
            tunnel.pendings.push(buffer)
            return
        }

        let extra: Buffer | null
        let left: Buffer | null

        if (has_extra) {
            const extra_start = extra_length_start + 2
            extra = buffer.subarray(extra_start, extra_start + extra_length)
            left = buffer.subarray(extra_start + extra_length)
        }
        else {
            left = buffer.subarray(2 + meta_length)
        }

        console.log("😈 recv mux cmd", tunnel.id, type)

        switch (type) {
            case 1:     //new
                this.mux_new(tunnel, context, meta, extra)
                break
            case 2:
                this.mux_keep(tunnel, context, meta, extra)
                break
            case 3:
                this.mux_end(tunnel, context, meta, extra)
                break
            case 4:
                this.mux_keepalive(tunnel, context, meta, extra)
                break
            default:
                tunnel.end()
                tunnel.destroy()
                break
        }


        if (left && left.length > 0) {
            console.log("😈 recv mux left > 0", tunnel.id, type)
            tunnel.pendings.push(left)
            this.mux(tunnel, context)
        }
    }

    mux_new(tunnel: CachedTunnel, context: ConnectionContext, meta: Buffer, extra?: Buffer) {

        const session: Session = {
            id: meta.readUInt16BE().toString(),
            meta,
            protocol: protocol_type_to_name[meta[4]],
            port: meta.readUInt16BE(5),
            host: "",
        }

        read_address(meta, session, 7)

        if (!session.host) {
            tunnel.destroy(new Error(`invalid addressType`))
            return
        }

        let tunnel_sessions = this.sessions[tunnel.id]
        if (tunnel_sessions == null) {
            tunnel_sessions = this.sessions[tunnel.id] = {}
        }

        // console.log("😀 recv mux new", tunnel.id, session.id, session.host, session.protocol)

        session.tunnel = this.createConnection(this.options.pass, { source: context.source, dest: session })

        if (extra && extra.length > 0) {
            session.tunnel.write(extra)
        }

        session.tunnel.on("data", (buffer: Buffer) => {
            this.send_keep_resp(tunnel, session, buffer)
        })
        session.tunnel.on("end", () => {
            if (session.tunnel.writableEnded) {
                return
            }
            session.tunnel.end()
            this.send_end_resp(tunnel, session)
        })

        session.tunnel.on("error", (e) => {
            session.tunnel.end()
            delete tunnel_sessions[session.id]
            this.send_keep_resp(tunnel, session, Buffer.alloc(0))
        })

        tunnel.on("end", () => {
            session.tunnel.end()
            delete tunnel_sessions[session.id]
        })

        tunnel.on("close", () => {
            session.tunnel.end()
            delete tunnel_sessions[session.id]
        })

        tunnel.on("error", () => {
            session.tunnel.end()
            tunnel.end()
            delete tunnel_sessions[session.id]
        })

        tunnel_sessions[session.id] = session
    }

    mux_keep(tunnel: CachedTunnel, context: ConnectionContext, meta: Buffer, extra?: Buffer) {

        let tunnel_sessions = this.sessions[tunnel.id]
        if (tunnel_sessions == null) {
            tunnel.end()
            return
        }

        const id = meta.readUInt16BE().toString()
        const session = tunnel_sessions[id]

        if (session == null) {
            // this.send_end_resp(tunnel, session)
            return
        }
        if (extra == null || extra.length == 0) {
            return
        }
        session.tunnel.write(extra)
    }

    mux_end(tunnel: CachedTunnel, context: ConnectionContext, meta: Buffer, extra?: Buffer) {

        let tunnel_sessions = this.sessions[tunnel.id]
        if (tunnel_sessions == null) {
            tunnel.end()
            return
        }

        const id = meta.readUInt16BE().toString()

        const session = tunnel_sessions[id]
        if (session == null) {
            return
        }

        console.log("mux end", tunnel.id, id, session.host)

        session.tunnel.end(extra)
        delete tunnel_sessions[id]

        // this.send_end_resp(tunnel, session)
    }

    mux_keepalive(tunnel: CachedTunnel, context: ConnectionContext, meta: Buffer, extra?: Buffer) { }

    send_keep_resp(tunnel: Tunnel, session: Session, extra: Buffer) {

        const meta = session.meta.subarray(0, 4)

        meta[2] = 2
        meta[3] = 1

        const resp = Buffer.alloc(2 + meta.length + 2)

        resp.writeUint16BE(meta.length)
        meta.copy(resp, 2)

        resp.writeUint16BE(extra.length, meta.length + 2)

        tunnel.write(resp)
        tunnel.write(extra)
    }

    send_end_resp(tunnel: Tunnel, session: Session) {

        console.log("😢 send mux end", tunnel.id, session.id)

        const meta = session.meta.subarray(0, 4)

        meta[2] = 3     //type
        meta[3] = 0     //has_opt

        const resp = Buffer.allocUnsafe(2)
        resp.writeUint16BE(meta.length)

        tunnel.write(resp)
        tunnel.write(meta)
    }
}