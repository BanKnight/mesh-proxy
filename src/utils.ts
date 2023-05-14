import http from "http"

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