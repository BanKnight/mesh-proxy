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

const S5_AddressType =
{
    [1]: "IPv4",
    [3]: "domain",
    [4]: "IPv6"
}

const S5_AddressType_Value = {
    IPv4: 1,
    domain: 3,
    IPv6: 4
}

const Common_AddressType =
{
    [1]: "IPv4",
    [2]: "domain",
    [3]: "IPv6"
}

const Common_AddressType_Value = {
    IPv4: 1,
    domain: 2,
    IPv6: 3
}

/**
 * addresstype: 01-->ipv4,02-->domain,03-->ipv6
 * socks5:IPV4: 0x01,domain:03,ipv6:04
 * @param buffer 
 * @param offset 
 * @param address 
 * @returns 
 */
export function read_address(buffer: Buffer, address: any, offset: number = 0, is_sockes5 = false) {

    const names = is_sockes5 ? S5_AddressType : Common_AddressType
    const address_type = buffer[offset++]
    const name = names[address_type]

    switch (name) {
        case "IPv4":      //ipv4
            {
                address.family = "IPv4"
                address.host = `${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}.${buffer[offset++]}`
            }
            break
        case "domain":      //domain
            {
                const size = buffer[offset++]
                address.host = buffer.subarray(offset, offset += size).toString()
            }
            break
        case "IPv6":      //ipv6
            {
                const array = []

                for (let i = 0; i < 8; i++) {
                    array.push(buffer.readUint16BE(offset).toString(16));
                    offset += 2
                }
                address.family = "IPv6"
                address.host = array.join(":")
            }
            break
        default:
            address.host = null
            break
    }

    address.address = address.host

    return offset
}

export function write_address(buffer: Buffer, address: any, offset: number = 0, is_sockes5 = false) {

    const address_type_pos = offset
    const names = is_sockes5 ? S5_AddressType_Value : Common_AddressType_Value

    buffer[offset++] = 1

    switch (address.family) {
        case "IPv4":
            {
                const array = (address.address || address.host).split(".")

                for (let i = 0; i < 4; ++i) {
                    const val = parseInt(array[i])
                    buffer[offset++] = val
                }

                buffer[address_type_pos] = names["IPv4"]
            }
            break
        case "IPv6":
            {
                const array = (address.address || address.host).split(":")

                for (let i = 0; i < 8; ++i) {
                    const val = parseInt(array[i], 16)
                    buffer.writeUint16BE(val, offset)
                    offset += 2
                }

                buffer[address_type_pos] = names["IPv6"]
            }
            break
        default:        //Domain
            {
                const sub = Buffer.from((address.address || address.host))

                buffer[offset++] = sub.byteLength

                sub.copy(buffer, offset, 0, offset += sub.byteLength)

                buffer[address_type_pos] = names["domain"]
            }
            break
    }

    return offset
}