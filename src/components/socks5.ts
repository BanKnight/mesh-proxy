import * as dgram from 'dgram';
import { Component, ComponentOption, CachedTunnel, Tunnel, ConnectionContext, ConnectListener } from "../types.js";
import { read_address, write_address } from '../utils.js';
import { finished } from 'stream';

//https://www.cnblogs.com/zahuifan/articles/2816789.html
//https://guiyongdong.github.io/2017/12/09/Socks5%E4%BB%A3%E7%90%86%E5%88%86%E6%9E%90/
let temp = Buffer.alloc(1024)
export default class Socks5 extends Component {

    users = new Map<string, any>()

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
            this.users.set(user.name, user)
        }
    }
    close() { }

    connection(tunnel: CachedTunnel, context: ConnectionContext, callback: ConnectListener) {

        callback()

        tunnel.pendings = []
        tunnel.next = this.handshake.bind(this, tunnel, context)
        tunnel.on("data", (buffer: Buffer) => {
            tunnel.pendings.push(buffer)
            tunnel.next()
        })

        // finished(tunnel, () => {
        //     tunnel.destroy()
        // })
    }

    from_pendings(tunnel: CachedTunnel, at_least_length: number) {

        let total = 0
        for (let one of tunnel.pendings) {
            total += one.length
        }
        if (total < at_least_length || total == 0) {
            return null
        }

        if (tunnel.pendings.length == 1) {
            return tunnel.pendings.pop()
        }

        const buffer = Buffer.allocUnsafe(total)

        let offset = 0

        while (tunnel.pendings.length < 0) {
            let one = tunnel.pendings.shift()
            one.copy(buffer, offset, one.length)
            offset += one.length
        }

        return buffer
    }
    handshake(tunnel: CachedTunnel, context: ConnectionContext) {

        const buffer = this.from_pendings(tunnel, 3)
        if (buffer == null) {
            return
        }

        const response = buffer //重用

        if (buffer[0] != 0x5) {
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
            tunnel.end(buffer)
            return
        }

        const nmethods = buffer[1]
        const methods: number[] = []

        for (let i = 2; i < nmethods + 2; i++) {
            methods.push(buffer[i]);
        }

        tunnel.next = null

        const noauth = this.users.size == 0

        if (noauth) {
            response[1] = RFC_1928_METHODS.NO_AUTHENTICATION_REQUIRED;
            tunnel.next = this.check_cmd.bind(this, tunnel, context)
        }
        else {
            if (methods.indexOf(RFC_1928_METHODS.BASIC_AUTHENTICATION) == -1) {
                response[1] = RFC_1928_METHODS.NO_ACCEPTABLE_METHODS;
            }
            else {
                response[1] = RFC_1928_METHODS.BASIC_AUTHENTICATION;
                tunnel.next = this.authenticate.bind(this, tunnel, context)
            }
        }

        const resp = response.subarray(0, 2)

        tunnel.write(resp)

        if (tunnel.next == null) {
            tunnel.end()
            tunnel.destroy()
            return
        }
    }

    authenticate(tunnel: CachedTunnel, context: ConnectionContext) {

        const buffer = this.from_pendings(tunnel, 3 + 2)
        if (buffer == null) {
            return
        }

        let offset = 0

        const version = buffer[offset++]
        const ulen = buffer[offset++]
        const uname = buffer.toString("utf-8", offset, offset += ulen)
        const plen = buffer[offset++]
        const password = buffer.toString("utf-8", offset, offset += plen)

        const response = buffer

        if (version != 0x05) {
            response[0] = 0x05
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
            tunnel.end(response)
            return
        }

        const exists = this.users.get(uname)

        if (exists == null || exists.password != password) {
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
            tunnel.end(response)
            return
        }

        response[1] = RFC_1928_REPLIES.SUCCEEDED
        tunnel.write(response.subarray(0, 2))
        tunnel.next = this.check_cmd.bind(this, tunnel, context)

        tunnel.next()
    }

    check_cmd(tunnel: CachedTunnel, context: ConnectionContext) {
        const buffer = this.from_pendings(tunnel, 7 + 3)
        if (buffer == null) {
            return
        }

        const version = buffer[0]
        const cmd = buffer[1]
        const rsv = buffer[2]

        const response = buffer

        if (version != 0x5) {

            response[0] = 0x5
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE

            tunnel.end(response)
            return
        }

        let dest = context.dest = {
            host: "",
            protocol: null,
            port: 0,
            family: null,
        }

        let offset = read_address(buffer, dest, 3, true)

        if (offset < 5 + 3) {
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
            tunnel.end(response)
            return
        }
        dest.port = buffer.readUInt16BE(offset) as unknown as number
        offset += 2

        const left = buffer.subarray(offset)

        if (left.length > 0) {
            tunnel.unshift(left)
        }

        tunnel.next = null
        tunnel.removeAllListeners("data")

        switch (cmd) {
            case RFC_1928_COMMANDS.BIND:
                // dest.protocol = "bind"
                this.on_cmd_bind(tunnel, context, response)
                break
            case RFC_1928_COMMANDS.CONNECT:
                dest.protocol = "tcp"
                this.on_cmd_connect(tunnel, context, response)
                break
            case RFC_1928_COMMANDS.UDP_ASSOCIATE:
                dest.protocol = "udp"
                this.on_cmd_udp(tunnel, context, response)
                break
        }
    }

    on_cmd_bind(tunnel: CachedTunnel, context: ConnectionContext, resp: Buffer) {
        resp[1] = RFC_1928_REPLIES.COMMAND_NOT_SUPPORTED
        tunnel.end(resp)
    }

    on_cmd_connect(tunnel: CachedTunnel, context: ConnectionContext, resp: Buffer) {

        //返回对端的地址给到客户端
        const next = this.createConnection(this.options.pass, { ...context, socks5: true }, (linfo: any) => {
            temp[0] = 0x05
            temp[1] = RFC_1928_REPLIES.SUCCEEDED
            temp[2] = 0

            let offset = write_address(temp, {
                host: linfo.remote.address,
                family: linfo.remote.family
            }, 3, true)

            offset = temp.writeUint16BE(linfo.remote.port, offset)

            tunnel.write(temp.subarray(0, offset))      //告知客户端
        })

        tunnel.pipe(next).pipe(tunnel)

        next.on("error", (e) => {
            if (next.readyState == "opening") {
                resp[1] = RFC_1928_REPLIES.GENERAL_FAILURE

                if (tunnel.writable) {
                    tunnel.end(resp)
                }
            }
            tunnel.destroy(e)
            next.destroy()
        })

    }

    /**
     * udp是映射源的思路，tcp是映射目标的思路
     * @param tunnel 
     * @param context 
     * @param resp 
     * @returns 
     */
    on_cmd_udp(tunnel: CachedTunnel, context: ConnectionContext, resp: Buffer) {

        //此时的dest实际是客户端的源udp地址
        //和之前的是dest不同
        let source = context.dest

        //同样的，自己也建立一个udp地址，用来映射源
        //由于udp可以通过localAddress+localPort 往不同的 remoteAddress + remotePort 发送
        const next = this.createConnection(this.options.pass, { dest: { protocol: "udp" }, socks5: true })
        const socket = dgram.createSocket("udp4")

        socket.bind(() => {      //告诉客户端用这个地址连过来
            temp[0] = 0x05
            temp[1] = RFC_1928_REPLIES.SUCCEEDED
            temp[2] = 0

            const address = socket.address()

            let offset = write_address(temp, {
                host: this.options.relay || (address.address == "0.0.0.0" ? "127.0.0.1" : address.address),
                family: address.family
            }, 3, true)

            offset = temp.writeUint16BE(address.port, offset)

            tunnel.write(temp.subarray(0, offset))      //告知客户端

            console.log(`component[${this.name}] is listening ${socket.address().address}:${socket.address().port}`)

            // resp[1] = RFC_1928_REPLIES.CONNECTION_NOT_ALLOWED
            // tunnel.write(resp)
        })

        /**
         *  +----+------+------+----------+----------+----------+
            |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
            +----+------+------+----------+----------+----------+
            | 2  |  1   |  1   | Variable |    2     | Variable |
            +----+------+------+----------+----------+----------+
         */
        socket.on("message", (buffer, rinfo) => {

            if (source.port == 0) {
                source.port = rinfo.port
                source.host = rinfo.address
            }
            else if (rinfo.port != source.port || (rinfo.address != source.host && source.host != "0.0.0.0")) {
                destroy_all()
                return
            }
            // 是否支持SOCKS碎片是可选的，如果一个SOCKS实现不支持SOCKS碎片，则必须丢弃所
            // 有接收到的SOCKS碎片，即那些FRAG字段非零的SOCKS UDP报文。
            const frag = buffer[2]
            if (frag != 0) {
                return
            }
            next.write(buffer.subarray(3))    //带地址传过去
        })

        next.on("data", (buffer: Buffer) => {   //buffer中已经是有带地址的了

            const need_length = buffer.length + 3
            let curr = temp

            if (curr.length < need_length) {
                curr = Buffer.allocUnsafe(need_length)
            }

            curr[0] = curr[1] = 0
            curr[2] = 0

            const bytes = buffer.copy(curr, 3)
            socket.send(curr.subarray(0, 3 + bytes), source.port, source.host)
        })

        function destroy_all() {
            socket.disconnect()
            next.destroy()
            tunnel.destroy()
        }

        tunnel.on("data", (data: Buffer) => {
            console.log("recv data", data.length)
        })

        tunnel.on("error", destroy_all)
        tunnel.on("end", destroy_all)
        tunnel.on("close", destroy_all)

        next.on("error", destroy_all)
        next.on("end", destroy_all)
        next.on("close", destroy_all)

        socket.on("error", destroy_all)
        socket.on("close", destroy_all)
    }
}

const RFC_1928_ATYP = {
    IPV4: 0x01,
    DOMAINNAME: 0x03,
    IPV6: 0x04
}

const RFC_1928_COMMANDS = {
    BIND: 0x02,
    CONNECT: 0x01,
    UDP_ASSOCIATE: 0x03
}

const RFC_1928_REPLIES = {
    ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
    COMMAND_NOT_SUPPORTED: 0x07,
    CONNECTION_NOT_ALLOWED: 0x02,
    CONNECTION_REFUSED: 0x05,
    GENERAL_FAILURE: 0x01,
    HOST_UNREACHABLE: 0x04,
    NETWORK_UNREACHABLE: 0x03,
    SUCCEEDED: 0x00,
    TTL_EXPIRED: 0x06
}

const RFC_1928_METHODS = {
    BASIC_AUTHENTICATION: 0x02,
    GSSAPI: 0x01,
    NO_ACCEPTABLE_METHODS: 0xff,
    NO_AUTHENTICATION_REQUIRED: 0x00
}

