//https://github.com/zizifn/edgetunnel/blob/main/libs/vless-js/src/lib/vless-js.ts

import * as net from 'net';
import { stringify } from "uuid"

//https://github.com/v2ray/v2ray-core/issues/2636
// 1 字节	  16 字节       1 字节	       M 字节	              1 字节            2 字节      1 字节	      S 字节	      X 字节
// 协议版本	  等价 UUID	  附加信息长度 M	(附加信息 ProtoBuf)  指令(udp/tcp)	    端口	      地址类型      地址	        请求数据
// 00                   00                                  01                 01bb(443)   02(ip/host)
// 1 字节	              1 字节	      N 字节	         Y 字节
// 协议版本，与请求的一致	附加信息长度 N	附加信息 ProtoBuf	响应数据

export interface VlessOptions { }

class VlessServer {
    options: VlessOptions = null
    server: net.Server = null

    constructor(options: VlessOptions = {}) {
        this.options = options

        this.server = net.createServer((socket) => {
            socket.once("data", this.authenticate.bind(this, socket))
            socket.on('error', (error: Error) => {
                console.error(error)
            });
        })
    }

    async authenticate(socket: net.Socket, buffer: Buffer) {

        if (buffer.length < 24) {
            socket.end()
            return
        }

        const version = buffer[0]
        const userid = stringify(buffer.subarray(1, 17))

        const optLength = buffer[17]
        const cmd = buffer[18 + optLength]

        let isudp = false
        if (cmd === 1) { }
        else if (cmd === 2) {
            isudp = true;
        }
        else {
            socket.end()        //not supported cmd
            return
        }

        const dest = {
            address: "",
            port: 0
        }

        const portIndex = 18 + optLength + 1;
        dest.port = buffer.readUInt16BE(portIndex) as unknown as number

        const address_type = buffer[portIndex + 2]

        let offset = address_type + 1

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
                socket.end()
                return
        }

        let arrays = this.server.listeners("authenticate")
        let accept = true

        if (arrays && arrays.length > 0) {
            const authenticate = arrays[0]
            accept = await authenticate(socket, version, userid, dest)
        }

        if (!accept) {
            socket.end()        //invalid user
            return
        }

        const head = buffer.subarray(offset)

        arrays = this.server.listeners("connecting")
        if (arrays && arrays.length > 0) {
            const connect = arrays[0]
            await connect(socket, dest, { address: socket.remoteAddress, port: socket.remotePort })
            return
        }
    }
}