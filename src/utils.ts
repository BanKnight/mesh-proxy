import http from "http"
import crypto from "crypto"

export function url_join(...args: string[]) {

    let lastIndex = args.length - 1,
        last = args[lastIndex],
        lastSegs = last.split('?')

    args[lastIndex] = lastSegs.shift();

    //
    // Join all strings, but remove empty strings so we don't get extra slashes from
    // joining e.g. ['', 'am']
    //
    let retSegs = [
        args.filter(Boolean).join('/')
            .replace(/\/+/g, '/')
            .replace('http:/', 'http://')
            .replace('https:/', 'https://')
    ];

    // Only join the query string if it exists so we don't have trailing a '?'
    // on every request

    // Handle case where there could be multiple ? in the URL.
    retSegs.push.apply(retSegs, lastSegs);

    return retSegs.join('?')
}

export function has_port(host: string) {
    return !!~host.indexOf(':');
};

export function basic_auth(req: http.IncomingMessage) {

    const auth = req.headers.authorization;
    if (auth == null) {
        return
    }

    const [scheme, credentials] = auth.split(' ');
    if (scheme != 'Basic') {
        return
    }

    const [username, password] = Buffer.from(credentials, 'base64').toString().split(':');
    return { username, password }
}

export function handle_upgrade(req: http.IncomingMessage, res: http.ServerResponse) {
    const head = req.headers.sec_websocket_key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const accept = crypto.createHash('sha1').update(head).digest('base64');

    res.writeHead(101, "Switching Protocols", {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Accept': accept
    },);
}

/**
 * addresstype: 01-->ipv4,02-->domain,03-->ipv6
 * @param buffer 
 * @param offset 
 * @param dest 
 * @returns 
 */
export function read_address(buffer: Buffer, dest: any, offset: number = 0) {

    //socks5     IPV4: 0x01,domain:03,ipv6:04
    const address_type = buffer[offset++]
    switch (address_type) {
        case 0x1:      //ipv4
            {
                dest.family = "ipv4"
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

                dest.family = "ipv6"
                for (let i = 0; i < 8; i++) {
                    address.push(buffer.readUint16BE(offset).toString(16));
                    offset += 2
                }
                dest.host = address.join(":")
            }
            break
        default:
            break
    }

    return offset
}

export function write_address(buffer: Buffer, dest: any, offset: number = 0) {

    const address_type_pos = offset

    buffer[offset++] = 1

    switch (dest.family) {
        case "ipv4":
            {
                const array = dest.host.split(".")

                for (let i = 0; i < 4; ++i) {
                    const val = parseInt(array[i])
                    buffer[offset++] = val
                }

                buffer[address_type_pos] = 1
            }
            break
        case "domain":
            {
                const sub = Buffer.from(dest.host)

                buffer[offset++] = sub.byteLength

                sub.copy(buffer, offset, 0, offset += sub.byteLength)

                buffer[address_type_pos] = 2
            }
            break
        case "ipv6":
            {
                const array = dest.host.split(":")

                for (let i = 0; i < 8; ++i) {
                    const val = parseInt(array[i], 16)
                    buffer.writeUint16BE(val, offset)
                    offset += 2
                }

                buffer[address_type_pos] = 1
            }
            break
    }

    return offset
}