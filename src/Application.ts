import { WebSocket, WebSocketServer } from "ws"
import { serialize, deserialize } from "v8"
import http from "http"
import https from "https"
import tls from "tls"

import url, { fileURLToPath, pathToFileURL, UrlWithStringQuery } from "url"
import { join, resolve, basename, dirname } from "path";
import { parse } from "yaml";
import { readFileSync, readdirSync } from "fs";
import { Config, Component, Node, ComponentOption, Tunnel, HttpServer, SiteInfo, WSocket, SiteOptions, ConnectListener, Location, Route } from "./types.js";
import { basic_auth } from "./utils.js"
import { Duplex } from "stream"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type Constructable<T> = new (...args: any[]) => T

export class Application {

    options: Config
    httpservers = new Map<number, HttpServer>()
    nodes: Record<string, Node> = {}           //[name] = node,有一个特殊的node表明是自己 [$self] = node
    tunnels: Record<string, Tunnel> = {}       //用于给远程tunnel发过来的
    templates: Record<string, Constructable<Component>> = {}       //
    /**
     * 路由表：[dest_node] = next_node，使用RIP协议维护
     * 参考：https://blog.csdn.net/TheCarol/article/details/112106308
     */
    routes: Record<string, Route> = {}

    constructor(file: string) {
        const content = readFileSync(resolve(file), "utf-8")
        this.options = Object.assign({ auth: {}, servers: [], components: [] },
            parse(content) as Config)
    }

    get name() {
        return this.options.name
    }

    async start() {

        await this.prepare_self()
        await this.connect_servers()

        this.prepare_components()

        if (this.options.listen) {
            this.as_server()
        }

        // let last_count = 0
        // setInterval(() => {
        //     let count = Object.keys(this.tunnels).length
        //     if (last_count != count) {
        //         console.log("tunnels count", count)
        //     }

        //     last_count = count
        // }, 5000)
    }
    as_server() {

        let key: string | null, cert: string | null

        if (this.options.ssl) {
            key = this.options.ssl.key
            cert = this.options.ssl.cert
        }

        if (key?.startsWith("file://")) {
            const file = fileURLToPath(key);
            key = readFileSync(file, "utf-8")
        }

        if (cert?.startsWith("file://")) {
            const file = fileURLToPath(cert);
            cert = readFileSync(file, "utf-8")
        }

        this.options.listen = url.parse(this.options.listen)

        const site = this.create_site({
            port: this.options.listen.port,
            host: this.options.listen.host || "",
            ssl: this.options.ssl ? { ...this.options.ssl, key, cert } : null
        })

        const wsserver = new WebSocketServer({ noServer: true })
        const that = this
        const location: Location = {
            upgrade: "websocket",
            callback(req, socket: Duplex, head: Buffer) {
                wsserver.handleUpgrade(req, socket, head, (socket: WSocket, req) => {

                    socket.setMaxListeners(Infinity)
                    socket.on("message", (data: Buffer, isBinanry) => {
                        const { event, args } = deserialize(data)
                        socket.emit(event, ...args)
                    })

                    socket.write = (event: string, ...args: any[]) => {
                        socket.send(serialize({ event, args }))
                    }
                    socket.once("auth", (data: { user: string, token: string }) => {

                        const config_user = that.options.auth[data.user]
                        if (config_user == null || config_user.token != data.token) {
                            socket.write("auth_failed")
                            socket.close()
                            return
                        }

                        console.log(`node[${data.user}] logined`)

                        let node = that.nodes[data.user]
                        if (node) {
                            socket.close()
                            console.log(`conflict node[${data.user}] logined, closed`)
                            return
                        }

                        node = new Node()
                        node.name = data.user
                        node.socket = socket

                        that.on_node_connected(node)
                        that.prepare_node_socket(node)
                    })

                    socket.on("error", (error: Error) => {
                        console.error(error)
                    })
                })
            }
        }

        site.locations.set(this.options.listen.path, location)
    }
    async connect_servers() {
        if (this.options.servers == null) {
            return
        }

        const all = []

        for (const one of this.options.servers) {

            const node = new Node()

            node.url = new URL(one.url)
            node.name = one.name

            all.push(new Promise((resolve, reject) => {
                this.connect_node(node)
                node.once("connect", resolve)
            }))
        }

        await Promise.all(all)
    }

    connect_node(node: Node, retry = 0) {

        const socket = node.socket = (new WebSocket(node.url)) as WSocket

        let connecting = true

        socket.on("message", (data: Buffer, isBinanry) => {
            const { event, args } = deserialize(data)
            socket.emit(event, ...args)
        })

        socket.write = (event: string, ...args: any[]) => {
            socket.send(serialize({ event, args }))
        }

        socket.on('open', () => {
            connecting = false
            retry = 0

            socket.write("auth", {
                user: node.url?.username,
                token: node.url?.password
            })
            this.prepare_node_socket(node)
            this.on_node_connected(node)

            const timer = setInterval(() => {
                if (socket.readyState == socket.CLOSED) {
                    clearInterval(timer)
                    return
                }
                else {
                    socket.ping()
                }
            }, 1000)

            node.emit("connect")
        });

        socket.on("error", (reason: Error) => {
            if (socket.CONNECTING) {
                console.error("connect", node.name, reason)
                setTimeout(this.connect_node.bind(this, node), 5000)
            }
        })

        socket.on('close', (code: number, reason: Buffer) => {
            node.socket = null
            const retry_timeout = Math.min(3000 * Math.pow(2, retry), 20000)

            if (connecting) {
                console.log(`connect node[${node.name}] error,retry after ${retry_timeout / 1000} seconds`);
            }
            else {
                console.log(`node[${node.name}] closed`);
            }
            retry++
            setTimeout(this.connect_node.bind(this, node, retry), retry_timeout)
        });

        socket.setMaxListeners(Infinity)
    }

    prepare_components() {

        if (this.options.components == null) {
            return
        }

        for (const options of this.options.components) {

            const names = options.name.split("/")
            if (names[0] != this.options.name) {
                continue
            }

            const node = this.nodes[names[0]]

            const component = this.create_component(options)

            component.node = node
            component.name = names[1]
            component.options = options
            component.create_site = this.create_site.bind(this)
            component.createConnection = this.connect_component.bind(this, component)

            node.components[component.name] = component


            console.log(`component[${component.name}] created`)

            component.setMaxListeners(Infinity)
            component.emit("ready")
            component.on("error", () => { })
        }
    }

    async prepare_self() {

        const folder = resolve(__dirname, 'components');
        const files = readdirSync(folder).filter(file => file.endsWith('.js'));

        for (const file of files) {
            const name = basename(file, ".js")
            const filePath = pathToFileURL(join(folder, file)).toString();
            const { default: component_class } = await import(filePath)

            this.templates[name] = component_class
        }

        const node = this.nodes[this.name] = new Node()
        node.name = this.name
        node.setMaxListeners(Infinity)

        this.routes[this.name] = {
            dest: this.name,
            distance: 0,
            next: this.name,
        }
    }

    wrap_error(error?: Error) {
        if (error == null) {
            return
        }

        return { message: error.message, stack: error.stack }
    }

    on_node_connected(node: Node) {

        console.log(`node[${node.name}] connected`)

        this.nodes[node.name] = node

        for (const component of this.options.components) {
            const names = component.name.split("/")
            if (names[0] != node.name) {
                continue
            }
            node.socket.write("regist", component)
        }

        //
        this.routes[node.name] = {
            dest: node.name,
            distance: 1,
            next: node.name,
        }

        this.send_my_routes(node)
    }

    on_node_disconnected(node: Node) {

        delete this.nodes[node.name]

        for (let dest in this.routes) {
            const route = this.routes[dest]

            //不要用直接删除的方案，因为还需要同步给到别人
            if (route.next != node.name) {
                continue
            }
            route.distance = Infinity        //表示不可达
        }

        for (const node_name in this.nodes) {
            const curr = this.nodes[node_name]
            if (node_name == this.name || curr.socket == null) {
                continue
            }
            this.send_my_routes(curr)
        }

        this.update_sites()
    }

    send_my_routes(node: Node) {

        const routes = {}

        for (let dest in this.routes) {
            const route = this.routes[dest]
            if (dest == this.name || dest == node.name) {
                continue
            }
            routes[dest] = route
        }

        node.socket.write("route", routes)
    }

    find_route_next(dest: string) {
        let route = this.routes[dest]
        if (route == null || route.distance == Infinity) {
            return null
        }
        return route.next
    }

    prepare_node_socket(node: Node) {

        this.update_sites()

        node.socket.on("auth_failed", () => {
            console.error("auth_failed")
        })

        node.socket.on("route", (routes: Record<string, Route>) => {

            let changed = false

            for (let dest in routes) {

                const route = routes[dest]
                const exists = this.routes[dest]

                if (this.nodes[dest]) {
                    continue
                }

                route.distance++

                if (exists == null) {
                    this.routes[dest] = route
                    changed = true
                }
                else if (route.next == exists.next) {
                    this.routes[dest] = route
                    changed = true
                }
                else if (route.distance < exists.distance) {
                    this.routes[dest] = route
                    changed = true
                }
            }

            if (!changed) {
                return
            }

            for (const node_name in this.nodes) {
                const curr = this.nodes[node_name]
                if (curr == node || curr.socket == null) {
                    continue
                }
                this.send_my_routes(curr)
            }
        })

        node.socket.on("close", (code, reason) => {
            console.log(`node[${node.name}] disconnected due to ${code} ${reason.toString("utf8")}`);
            this.on_node_disconnected(node)
        })

        node.socket.on("regist", (options: ComponentOption) => {

            const names = options.name.split("/")
            const that = this.nodes[names[0]]

            const component = this.create_component(options)

            component.name = names[1]
            component.node = that
            component.options = options
            component.create_site = this.create_site.bind(this)
            component.createConnection = this.connect_component.bind(this, component)
            component.setMaxListeners(Infinity)

            that.components[component.name] = component

            console.log(`component[${options.name}] created from: ${node.name}`)

            component.emit("ready")

            const on_disconnect = () => {

                node.socket.off("close", on_disconnect)

                const exists = delete that.components[component.name]

                if (exists) {
                    console.log(`component[${options.name}] destroy when node[${node.name}] close`)
                    component.destroy()
                }
            }

            node.socket.on("close", on_disconnect)
        })

        node.socket.on("tunnel::connect", async (id: string, destination: string, ...args: any[]) => {

            const names = destination.split("/")
            const that = this.nodes[names[0]]
            const component = that.components[names[1]]

            if (component == null) {
                const error = new Error(`no such component: ${destination}`)
                node.socket.write("tunnel::error", id, { message: error.message, stack: error.stack })
                return
            }

            const tunnel = this.tunnels[id] = new Tunnel(id)

            // console.log(this.name, "tunnel::connect,from:", node.name, id, destination)

            tunnel.setMaxListeners(Infinity)

            tunnel.destination = `${node.name}/?`
            tunnel.readyState = "open"

            tunnel._write = (chunk, encoding, callback) => {
                node.socket?.write("tunnel::data", id, chunk)
                callback()
            }

            tunnel._read = () => { };
            tunnel._final = (callback: (error?: Error | null) => void) => {
                node.socket?.write("tunnel::final", id)
                tunnel.readyState = "readOnly"
                callback()
                if (tunnel.readableEnded) {
                    tunnel.destroy()
                }
            }

            tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
                node.socket?.write("tunnel::close", id)
                delete this.tunnels[id]
                tunnel.readyState = "closed"
                callback(error)
            }

            tunnel.on("error", () => {
                tunnel.end()
            })

            tunnel.cork()
            component.emit("connection", tunnel, ...args, (...args: any[]) => {
                tunnel.uncork()
                node.socket?.write("tunnel::connection", id, ...args)
            })

            let destroy = (reason: string) => {
                const existed = this.tunnels[id]
                if (!existed) {
                    return
                }
                existed.destroy(new Error(reason))
            }

            //对端断开了，那么tunnel也要销毁
            node.socket.once("close", destroy.bind(null, "node close"))
            component.once("close", destroy.bind(null, "component close"))
        })

        node.socket.on("tunnel::connection", (id: string, ...args: any[]) => {

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                node.socket.write("tunnel::close", id)
                return
            }


            tunnel.connecting = false
            tunnel.readyState = "open"

            tunnel.emit("connect", ...args)
        })

        node.socket.on("tunnel::message", (id: string, event: string, ...args: any[]) => {
            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }
            tunnel.emit(`message.${event}`, ...args)
        })

        node.socket.on("tunnel::data", (id: string, chunk: any) => {
            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }
            tunnel.push(chunk)
        })

        node.socket.on("tunnel::final", (id: string) => {

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }

            //对端停止发送数据过来，那么这条通路就可以关了
            delete this.tunnels[id]

            // console.log(this.name, "tunnel::final from", node.name, tunnel.id)

            tunnel.readyState = "writeOnly"
            tunnel.emit("end")
        })

        node.socket.on("tunnel::error", (id: string, error: any) => {

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }

            const e = new Error(error.message)

            e.name = error.name;
            e.stack = e.stack + '\n' + error.stack;

            tunnel.emit("error", e)
        })

        node.socket.on("tunnel::close", (id: string, error?: any) => {

            const tunnel = this.tunnels[id]
            if (tunnel == null) {
                return
            }

            // console.log(this.name, "tunnel::destroy,from:", node.name, id)

            delete this.tunnels[id]

            if (error) {

                const e = new Error(error.message)

                e.name = error.name;
                e.stack = error.stack;

                tunnel.emit("error", e)
            }
            tunnel.emit("close")
        })

    }

    create_component(options: ComponentOption) {

        const class_ = this.templates[options.type]
        if (class_ == null) {
            throw new Error(`unsupported component type: ${options.type} in ${options.name}`)
        }

        return new class_(options)
    }

    connect_component(from_component: Component, address: string, context: { source: any, dest: any }, callback?: ConnectListener) {
        const tunnel = new Tunnel()

        tunnel.destination = address
        tunnel.setMaxListeners(Infinity)

        if (callback) {
            tunnel.once("connect", callback)
        }

        const [dest_node, dest_component] = address.split("/")
        const next_node = this.find_route_next(dest_node)

        const target = this.nodes[next_node]

        if (target == null) {
            tunnel._read = () => { }
            setImmediate(() => {
                tunnel.destroy(new Error(`tunnel to ${address} failed,no such node: ${dest_node}`))
            })
            return tunnel
        }

        let destroy = (id: string, reason?: string) => {

            const existed = this.tunnels[id]

            if (!existed) {
                return
            }

            delete this.tunnels[id]

            if (existed.closed || existed.destroyed) {
                return
            }

            if (reason) {
                existed.destroy(new Error(`tunnel to ${address} ${reason}`))
            }
            else {
                existed.destroy()
            }
        }

        const id = tunnel.id

        from_component.once("close", destroy.bind(null, tunnel.id, "from componenet close"))

        if (target.socket) {

            // console.log(this.name, "tunnel::connect_component ,from:", from_component.name, id, address)

            this.tunnels[tunnel.id] = tunnel

            target.socket.write("tunnel::connect", tunnel.id, address, context)

            tunnel._read = () => { }
            tunnel._write = (chunk, encoding, callback) => {
                target.socket?.write("tunnel::data", tunnel.id, chunk)
                callback()
            }

            //本方不再发送数据数据
            tunnel._final = (callback: (error?: Error | null) => void) => {
                target.socket?.write("tunnel::final", tunnel.id)
                callback()

                if (tunnel.readableEnded) {
                    tunnel.destroy()
                }
            }
            tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
                target.socket?.write("tunnel::close", id, this.wrap_error(error))
                delete this.tunnels[id]
                callback(error)
            }

            //对端断开了，那么tunnel也要销毁
            target.socket.once("close", destroy.bind(null, tunnel.id, `from component[${from_component.name}] destroy because of node[${target.name}] closed`))

            return tunnel
        }

        const component = target.components[dest_component]

        if (component == null) {
            setImmediate(() => {
                tunnel.emit("error", new Error(`connect error, such component: ${address}`))
            })
            return tunnel
        }

        const revert = new Tunnel()

        revert.setMaxListeners(Infinity)

        tunnel._write = (chunk, encoding, callback) => {
            if (!revert.push(chunk, encoding)) {
                tunnel.pause();
            }
            callback()
        }

        revert._write = (chunk, encoding, callback) => {
            if (!tunnel.push(chunk, encoding)) {
                revert.pause();
            }
            callback()
        }

        tunnel._read = () => {
            if (revert.isPaused) {
                revert.resume()
            }
        };
        revert._read = () => {
            if (tunnel.isPaused) {
                tunnel.resume()
            }
        };

        tunnel._final = (callback: (error?: Error | null) => void) => {

            callback()

            tunnel.readyState = "readOnly"
            revert.emit("end")
            if (tunnel.readableEnded) {
                tunnel.destroy()
            }
        }

        revert._final = (callback: (error?: Error | null) => void) => {

            callback()

            revert.readyState = "readOnly"

            tunnel.emit("end")

            if (revert.readableEnded) {
                revert.destroy()
            }
        }
        tunnel._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
            tunnel.readyState = "closed"
            callback(error)
            revert.emit("close")
        }

        revert._destroy = (error: Error | null, callback: (error: Error | null) => void) => {
            revert.readyState = "closed"
            callback(error)
            tunnel.emit("close")
        }

        revert.on("error", () => { })       //no op
        revert.connecting = false
        revert.readyState = "open"
        revert.cork()

        component.once("close", destroy.bind(null, revert.id, `tunnel[${revert.id}] destroy because parent[${component.name}] closed`))
        setImmediate(() => {
            component.emit("connection", revert, context, (...args: any[]) => {

                revert.uncork()

                tunnel.connecting = false
                tunnel.readyState = "open"

                tunnel.emit("connect", ...args)
            })
        })

        return tunnel
    }


    create_site(options: SiteOptions) {

        let port_server = this.httpservers.get(options.port)
        if (port_server == null) {
            port_server = this.create_http_server(options)
        }

        // else if ((port_server.ssl == null) != (options.ssl == null)) {
        //     throw new Error(`confict ssl options at ${options.port}`)
        // }

        let site = port_server.sites.get(options.host)
        if (site) {
            return site
        }

        site = {
            host: options.host,
            locations: new Map(),
            auth: new Map(),
        }

        if (options.ssl) {
            site.context = tls.createSecureContext(options.ssl);
        }

        port_server.sites.set(site.host, site)

        return site
    }

    update_sites() {

        for (const [port, server] of this.httpservers) {
            for (let [domain, site] of server.sites) {
                if (site.locations.size == 0) {
                    server.sites.delete(domain)
                }
            }

            if (server.sites.size == 0) {
                this.httpservers.delete(port)
                server.close()
                console.log("unlisten", port)
            }
        }
    }



    create_http_server(options: SiteOptions) {

        let server: HttpServer

        if (options.ssl) {

            server = https.createServer({
                ...options,
                SNICallback: (servername, cb) => {
                    const site = server.sites.get(servername)
                    if (site) {
                        cb(null, site.context);
                    } else {
                        cb(new Error('No such server'));
                    }
                }
            }) as HttpServer

            server.port = options.port || 443
            server.ssl = true
        }
        else {
            server = http.createServer({ ...options }) as HttpServer
            server.port = options.port || 80
            server.ssl = false
        }

        server.sites = new Map()

        function get_site(req: http.IncomingMessage) {
            let site = server.sites.get(req.headers.host)
            if (site == null) {
                site = server.sites.get("")
            }
            return site
        }

        const extract_locations = {}
        const prefix_locations: { path: string, location: Location }[] = []
        const reg_locations: { path: string, location: Location }[] = []
        const default_locations: { path: string, location: Location }[] = []

        let prepare_locations = false

        function prepare(site: SiteInfo) {

            if (prepare_locations) {
                return
            }
            for (let [path, location] of site.locations) {
                if (path.startsWith("=")) {
                    extract_locations[path.substring(2)] = location
                }
                else if (path.startsWith("^~")) {
                    prefix_locations.push({ path: path.substring(2), location })
                }
                else if (path.startsWith("/")) {
                    default_locations.push({ path, location })
                }
                else {
                    reg_locations.push({ path, location })
                }
            }

            function compare(first: { path: string }, second: { path: string }) {
                return first.path.length - second.path.length
            }

            prefix_locations.sort(compare)
            reg_locations.sort(compare)
            default_locations.sort(compare)
        }

        function find(site: SiteInfo, uri: string): Location | null {

            prepare(site)

            let location = extract_locations[uri]
            if (location) {
                return location
            }

            for (const { path, location } of prefix_locations) {
                if (uri.startsWith(path)) {
                    return location
                }
            }

            for (const { path, location } of reg_locations) {
                const reg = new RegExp(path)
                if (reg.test(uri)) {
                    return location
                }
            }

            for (const { path, location } of default_locations) {
                if (uri.startsWith(path)) {
                    return location
                }
            }
        }

        server.on("request", (req, res) => {
            let site = get_site(req)
            if (site == null) {
                res.writeHead(404);
                res.end();
                return;
            }

            if (site.auth.size > 0) {
                const credentials = basic_auth(req)
                if (credentials == null) {
                    res.writeHead(404);
                    res.end("Unauthorized");
                    return;
                }

                const pass = site.auth.get(credentials.username)

                if (pass != credentials.password) {
                    res.writeHead(401, "Unauthorized")
                    res.end()
                    return
                }
            }

            req.socket.setKeepAlive(true)
            req.socket.setNoDelay(true)
            req.socket.setTimeout(0)

            const index = req.url.indexOf('?');
            const uri = index !== -1 ? req.url.slice(0, index) : req.url;

            const location = find(site, uri)   //location
            if (location == null) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }

            location.callback(req, res)
        })

        server.on("upgrade", (req, socket, head) => {

            let site = get_site(req)
            if (site == null) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            if (site.auth.size > 0) {
                const credentials = basic_auth(req)
                if (credentials == null) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }

                const pass = site.auth.get(credentials.username)

                if (pass != credentials.password) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return
                }
            }

            const index = req.url.indexOf('?');
            const uri = index !== -1 ? req.url.slice(0, index) : req.url;

            const location = find(site, uri)   //location
            if (location == null) {
                socket.write('HTTP/1.1 401 unsupport this location\r\n\r\n');
                socket.destroy();
                return;
            }
            req.socket.setTimeout(0);
            req.socket.setNoDelay(true);
            req.socket.setKeepAlive(true, 0);

            location.callback(req, socket, head)
        })
        server.listen(server.port, () => {
            console.log("http listening:", server.port)
        })

        server.on('error', (e: any) => {

            console.error(e)

            if (e.code === 'EADDRINUSE') {
                console.log('Address in use, retrying...');
                setTimeout(() => {
                    server.close();
                    server.listen(server.port);
                }, 1000);
            }
        });

        this.httpservers.set(server.port, server)

        return server
    }

}

process.on("uncaughtException", (error: Error, origin: any) => {
    console.error("uncaughtException", error)
})

process.on("unhandledRejection", (error: Error, origin: any) => {
    console.error("unhandledRejection", error)
})