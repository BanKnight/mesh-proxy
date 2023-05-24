import { Component, ComponentOption, CachedTunnel, Tunnel, ConnectionContext, ConnectListener } from "../types.js";

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

        tunnel.write(response.subarray(0, 2))

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
    }

    check_cmd(tunnel: CachedTunnel, context: ConnectionContext) {
        const buffer = this.from_pendings(tunnel, 7 + 4)
        if (buffer == null) {
            return
        }

        const version = buffer[0]
        const cmd = buffer[1]
        const rsv = buffer[2]
        const atyp = buffer[3]

        const response = buffer

        if (version != 0x5) {

            response[0] = 0x5
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE

            tunnel.end(response)
            return
        }

        let dest = {
            host: "",
            protocol: null,
            port: 0,
            // family: "",
        }

        let offset = 4

        switch (atyp) {
            case RFC_1928_ATYP.IPV4:
                {
                    // dest.family = "IPV4"
                    dest.host = `${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}`
                }
                break
            case RFC_1928_ATYP.DOMAINNAME:
                {
                    const size = buffer[offset++]
                    dest.host = buffer.subarray(offset, offset += size).toString()
                    // dest.family = "domain"
                }
                break
            case RFC_1928_ATYP.IPV6:
                {
                    const size = 16
                    const address = []

                    buffer.subarray(offset, offset += size).forEach((x) => {
                        address.push((x >>> 16).toString(16));
                        address.push(((x & 0xffff)).toString(16));
                    })

                    dest.host = address.join(":")
                    // dest.family = "IPV6"
                }
                break
            default:
                response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
                tunnel.end(response)
                return
        }

        dest.port = buffer.readUInt16BE(offset) as unknown as number

        tunnel.next = null
        tunnel.removeAllListeners("data")

        dest = context.dest = Object.assign(context.dest || {}, dest)

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

        const next = this.createConnection(this.options.pass, context, () => {
            resp[1] = RFC_1928_REPLIES.SUCCEEDED
            tunnel.write(resp)
        })

        tunnel.pipe(next).pipe(tunnel)

        next.on("error", (e) => {
            if (next.readyState == "opening") {
                resp[1] = RFC_1928_REPLIES.GENERAL_FAILURE

                if (tunnel.writable) {
                    tunnel.end(resp)
                }
            }
            // tunnel.destroy(e)
            // next.destroy()
        })

    }

    on_cmd_udp(tunnel: CachedTunnel, context: ConnectionContext, resp: Buffer) {
        resp[1] = RFC_1928_REPLIES.COMMAND_NOT_SUPPORTED
        tunnel.end(resp)
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

