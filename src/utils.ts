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