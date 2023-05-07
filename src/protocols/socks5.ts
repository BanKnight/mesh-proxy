import * as net from 'net';

const
    RFC_1928_ATYP = {
        DOMAINNAME: 0x03,
        IPV4: 0x01,
        IPV6: 0x04
    },
    RFC_1928_COMMANDS = {
        BIND: 0x02,
        CONNECT: 0x01,
        UDP_ASSOCIATE: 0x03
    },
    RFC_1928_METHODS = {
        BASIC_AUTHENTICATION: 0x02,
        GSSAPI: 0x01,
        NO_ACCEPTABLE_METHODS: 0xff,
        NO_AUTHENTICATION_REQUIRED: 0x00
    },
    RFC_1928_REPLIES = {
        ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
        COMMAND_NOT_SUPPORTED: 0x07,
        CONNECTION_NOT_ALLOWED: 0x02,
        CONNECTION_REFUSED: 0x05,
        GENERAL_FAILURE: 0x01,
        HOST_UNREACHABLE: 0x04,
        NETWORK_UNREACHABLE: 0x03,
        SUCCEEDED: 0x00,
        TTL_EXPIRED: 0x06
    },
    RFC_1928_VERSION = 0x05,
    RFC_1929_REPLIES = {
        GENERAL_FAILURE: 0xff,
        SUCCEEDED: 0x00
    },
    RFC_1929_VERSION = 0x01

export interface SocksOptions { }

class SocksServer {

    options: SocksOptions = null
    server: net.Server = null

    constructor(options: SocksOptions = {}) {
        this.options = options

        this.server = net.createServer((socket) => {
            socket.once("data", this.handshake.bind(this, socket))
            socket.on('error', (error: Error) => {
                console.error(error)
            });

        })
    }

    handshake(socket: net.Socket, buffer: Buffer) {

        if (buffer.length < 3) {
            socket.end()
            return
        }

        const response = buffer //重用

        if (buffer[0] != RFC_1928_VERSION) {
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
            socket.end(buffer)
            return
        }

        const noauth = this.server.listeners("auth").length == 0

        const nmethods = buffer[1]
        const methods: number[] = []

        for (let i = 2; i < nmethods + 2; i++) {
            methods.push(buffer[i]);
        }

        if (noauth) {
            response[1] = RFC_1928_METHODS.NO_AUTHENTICATION_REQUIRED;
            socket.write(response.subarray(0, 2))
            socket.once('data', this.connect.bind(this, socket));
        }
        else {
            if (methods.indexOf(RFC_1928_METHODS.BASIC_AUTHENTICATION) == -1) {
                response[1] = RFC_1928_METHODS.NO_ACCEPTABLE_METHODS;
                socket.end(response)
            }
            else {
                response[1] = RFC_1928_METHODS.BASIC_AUTHENTICATION;
                socket.once("data", this.authenticate.bind(this, socket))
                socket.write(response.subarray(0, 2))
            }
        }
    }

    /**
     * +----+-----+-------+------+----------+----------+
     * |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
     * +----+-----+-------+------+----------+----------+
     * | 1  |  1  | X'00' |  1   | Variable |    2     |
     * +----+-----+-------+------+----------+----------+
     *
     */
    async connect(socket: net.Socket, buffer: Buffer) {
        if (buffer.length < 7 + 4) {
            socket.end()
            return
        }

        const version = buffer[0]
        const cmd = buffer[1]
        const rsv = buffer[2]
        const atyp = buffer[3]

        const response = buffer

        if (version != RFC_1928_VERSION) {

            response[0] = RFC_1928_VERSION
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE

            socket.end(response)
            return
        }

        const dest = {
            address: "",
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
                socket.end(response)
                return
        }

        dest.port = buffer.readUInt16BE(offset) as unknown as number

        if (cmd != RFC_1928_COMMANDS.CONNECT) {     //udp
            response[1] = RFC_1928_REPLIES.SUCCEEDED
            socket.end(response)
            return
        }

        const arrays = this.server.listeners("connecting")
        if (arrays && arrays.length > 0) {
            response[1] = RFC_1928_REPLIES.SUCCEEDED
            socket.write(response);

            const connect = arrays[0]
            await connect(socket, dest, { address: socket.remoteAddress, port: socket.remotePort })
            return
        }

        const destination = net.createConnection(dest.port, dest.address)

        destination.on("error", (error: any) => {

            console.error(error)

            response[1] = RFC_1928_REPLIES.NETWORK_UNREACHABLE
            if (error.code == null) {
                socket.end(response)
                return
            }
            if (error.code === 'EADDRNOTAVAIL') {
                response[1] = RFC_1928_REPLIES.HOST_UNREACHABLE
            }
            else if (error.code && error.code === 'ECONNREFUSED') {
                response[1] = RFC_1928_REPLIES.CONNECTION_REFUSED
            }
            socket.end(response)
            return
        })

        destination.once("connect", () => {

            response[1] = RFC_1928_REPLIES.SUCCEEDED

            socket.write(response, () => {
                destination.pipe(socket);
                socket.pipe(destination);
            });
        })
    }

    /**
    * +----+------+----------+------+----------+
    * |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
    * +----+------+----------+------+----------+
    * | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
    * +----+------+----------+------+----------+
    *
    *
    * @param {Buffer} buffer - a buffer
    * @returns {undefined}
    **/
    async authenticate(socket: net.Socket, buffer: Buffer) {

        if (buffer.length < 3 + 2) {
            socket.end()
            return
        }

        let offset = 0

        const version = buffer[offset++]
        const ulen = buffer[offset++]
        const uname = buffer.toString("utf-8", offset, offset += ulen)
        const plen = buffer[offset++]
        const password = buffer.toString("utf-8", offset, offset += plen)

        const response = buffer

        if (version != RFC_1928_VERSION) {

            response[0] = RFC_1928_VERSION
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE

            socket.end(response)
            return
        }

        let accept = true
        const arrays = this.server.listeners("authenticate")

        if (arrays && arrays.length > 0) {
            const authenticate = arrays[0]
            accept = await authenticate(socket, uname, password)
        }

        if (!accept) {
            response[1] = RFC_1928_REPLIES.GENERAL_FAILURE
            socket.end(response)
            return
        }
        response[1] = RFC_1928_REPLIES.SUCCEEDED
        socket.write(response.subarray(0, 2))

        socket.once('data', this.connect.bind(this, socket));
    }
}

export function createServer(options?: SocksOptions) {
    const server = new SocksServer(options)
    return server.server
}