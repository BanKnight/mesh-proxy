import { Component, ComponentOption, Tunnel } from "../types.js";

export default class Socks5 extends Component {

    users = new Map<string, any>()

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
            this.users.set(user.name, user)
        }
    }
    close() { }

    connection<T extends Tunnel & { pendings?: Buffer }>(tunnel: T, source: any) {
        tunnel.on("data", this.handshake.bind(this, tunnel, source))
    }

    handshake<T extends Tunnel & { pendings?: Buffer }>(tunnel: T, source: any, buffer: Buffer) {

        if (tunnel.pendings == null) {
            tunnel.pendings = buffer
        }
        else {
            buffer.copy(tunnel.pendings, tunnel.pendings.length)
        }

        buffer = tunnel.pendings

        if (buffer.length < 3) {
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

        tunnel.pendings = null
        tunnel.removeAllListeners("data")

        const noauth = this.users.size == 0

        if (noauth) {
            response[1] = RFC_1928_METHODS.NO_AUTHENTICATION_REQUIRED;
            tunnel.write(response.subarray(0, 2))
            tunnel.once('data', this.connect_remote.bind(this, tunnel, source));
        }
        else {
            if (methods.indexOf(RFC_1928_METHODS.BASIC_AUTHENTICATION) == -1) {
                response[1] = RFC_1928_METHODS.NO_ACCEPTABLE_METHODS;
                tunnel.end(response.subarray(0, 2))
            }
            else {
                response[1] = RFC_1928_METHODS.BASIC_AUTHENTICATION;
                tunnel.write(response.subarray(0, 2))
                tunnel.once("data", this.authenticate.bind(this, tunnel, source))
            }
        }
    }

    authenticate<T extends Tunnel & { pendings?: Buffer }>(tunnel: T, source: any, buffer: Buffer) {

        if (tunnel.pendings == null) {
            tunnel.pendings = buffer
        }
        else {
            buffer.copy(tunnel.pendings, tunnel.pendings.length)
        }

        buffer = tunnel.pendings

        if (buffer.length < 3 + 2) {
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

        tunnel.pendings = null
        tunnel.removeAllListeners("data")
        tunnel.on('data', this.check_cmd.bind(this, tunnel, source));
    }

    check_cmd<T extends Tunnel & { pendings?: Buffer }>(tunnel: T, source: any, buffer: Buffer) {

        if (tunnel.pendings == null) {
            tunnel.pendings = buffer
        }
        else {
            buffer.copy(tunnel.pendings, tunnel.pendings.length)
        }

        buffer = tunnel.pendings
        if (buffer.length < 7 + 4) {
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

        const dest = {
            address: "",
            protocol: null,
            port: 0
        }

        let offset = 4

        switch (atyp) {
            case RFC_1928_ATYP.IPV4:
                {
                    dest.address = `${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}`
                }
                break
            case RFC_1928_ATYP.DOMAINNAME:
                {
                    const size = buffer[offset++]
                    dest.address = buffer.subarray(offset, offset += size).toString()
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

                    dest.address = address.join(":")
                }
                break
            default:
                response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
                tunnel.end(response)
                return
        }

        dest.port = buffer.readUInt16BE(offset) as unknown as number

        tunnel.pendings = null
        tunnel.removeAllListeners("data")

        switch (cmd) {
            case RFC_1928_COMMANDS.BIND:
                this.on_cmd_bind(tunnel, source, dest, response)
                break
            case RFC_1928_COMMANDS.CONNECT:
                dest.protocol = "tcp"
                this.on_cmd_connect(tunnel, source, dest, response)
                break
            case RFC_1928_COMMANDS.UDP_ASSOCIATE:
                this.on_cmd_udp(tunnel, source, dest, response)
                break
        }
    }

    on_cmd_bind(tunnel: Tunnel, source: any, dest: any, resp: Buffer) {
        resp[1] = RFC_1928_REPLIES.COMMAND_NOT_SUPPORTED
        tunnel.end(resp)
    }

    on_cmd_connect(tunnel: Tunnel, source: any, dest: any, resp: Buffer) {

        this.connect_remote(this.options.passes.tcp, source, dest, (error: Error | undefined, next?: Tunnel) => {

            resp[1] = RFC_1928_REPLIES.SUCCEEDED
            tunnel.write(resp)

            function destroy() {
                tunnel.destroy()
                next.destroy()
            }

            tunnel.on("error", destroy)
            tunnel.on("close", destroy)

            next.on("error", destroy)
            next.on("close", destroy)

            tunnel.pipe(next)
            next.pipe(tunnel)
        })
    }

    on_cmd_udp(tunnel: Tunnel, source: any, dest: any, resp: Buffer) {
        resp[1] = RFC_1928_REPLIES.COMMAND_NOT_SUPPORTED
        tunnel.end(resp)
    }
}

const RFC_1928_ATYP = {
    DOMAINNAME: 0x03,
    IPV4: 0x01,
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

