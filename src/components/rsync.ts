import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";
import fs from "fs"
import path from "path"

export default class Rsync extends Component {
    root: string
    timer: NodeJS.Timer;
    files: Record<string, fs.Stats> = {}
    interval = 0

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {

        this.root = path.resolve(this.options.root)
        this.interval = this.options.interval || 5000

        try {
            fs.mkdirSync(this.root, { recursive: true })
        }
        catch (e) { }

        this.walk(this.root)

        this.timer = setInterval(() => {
            this.files = {}
            this.walk(this.root)

            if (this.options.pass) {
                this.check()
            }
        })

        if (this.options.pass == null) {
            return
        }
        this.check()
    }
    close() {
        clearInterval(this.timer)
    }

    check() {
        const tunnel = this.createConnection(this.options.pass, { cmd: "list" }, (files: Record<string, any>) => {
            setImmediate(this.begin_sync.bind(this, files))
            tunnel.destroy()
        })

        tunnel.on("error", () => {
            tunnel.destroy()
        })
    }

    walk(parent: string) {

        const files = fs.readdirSync(parent)

        for (const file of files) {

            const whole = path.join(parent, file)
            const stats = fs.statSync(whole)

            if (stats.isDirectory()) {
                this.walk(whole)
                continue
            }

            const relative = path.relative(this.root, whole)

            this.files[relative] = {
                ...stats,
            }
        }
    }

    begin_sync(files: Record<string, fs.Stats>) {

        const deletes = []
        const adds = []
        const updates = []

        for (let relative in this.files) {

            let local = this.files[relative]
            let remote = files[relative]

            if (remote == null) {
                adds.push(relative)
                continue
            }

            if (local.size != remote.size) {
                updates.push(relative)
                continue
            }

            if (Math.abs(local.mtimeMs - remote.mtimeMs) >= 1) {
                updates.push(relative)
            }
        }

        if (this.options.check_delete) {
            for (let relative in files) {
                let local = this.files[relative]
                if (local == null) {
                    deletes.push(relative)
                    continue
                }
            }
        }

        if (deletes.length > 0) {
            this.sync_deletes(deletes)
        }

        if (adds.length > 0) {
            this.sync_adds(adds)
        }

        if (updates.length > 0) {
            this.sync_updates(updates)
        }
    }

    sync_deletes(deletes: string[]) {
        const tunnel = this.createConnection(this.options.pass, { cmd: "delete", files: deletes }, () => {
            tunnel.destroy()
        })
    }

    sync_adds(array: string[]) {
        this.sync_updates(array)
    }

    sync_updates(array: string[]) {

        for (const relative of array) {

            const whole = path.join(this.root, relative)
            const stats = fs.statSync(whole)
            const stream = fs.createReadStream(whole)

            const tunnel = this.createConnection(this.options.pass, { cmd: "update", relative, stats })

            stream.pipe(tunnel)
            stream.on("close", () => {
                tunnel.destroy()
            })
            tunnel.on("error", () => {
                stream.close()
            })
            tunnel.on("end", () => {
                stream.close()
            })
            tunnel.on("close", () => {
                stream.close()
            })
        }
    }

    connection(tunnel: Tunnel, context: ConnectionContext & { cmd: string, files?: [], realative?: string, stats?: any }, callback: ConnectListener) {

        switch (context.cmd) {
            case "list":
                this.do_list(tunnel, context, callback)
                break
            case "delete":
                this.do_delete(tunnel, context, callback)
                break
            case "update":
                this.do_update(tunnel, context, callback)
                break
        }
    }

    do_list(tunnel: Tunnel, context: any, callback: ConnectListener) {
        callback(null, this.files)
        tunnel.end()
    }

    do_delete(tunnel: Tunnel, context: { files?: string[] }, callback: ConnectListener) {

        callback()
        tunnel.destroy()

        for (let relative of context.files) {

            const whole = path.join(this.root, relative)
            delete this.files[whole]

            if (fs.existsSync(whole) == false) {
                continue
            }
            try {
                fs.unlinkSync(whole)
            }
            catch (e) {
                console.error(e)
            }
        }
    }

    do_update(tunnel: Tunnel, context: { relative?: string, stats?: fs.Stats }, callback: ConnectListener) {

        callback()

        const whole = path.join(this.root, context.relative)
        const parent = path.resolve(whole, "../")

        if (fs.existsSync(whole)) {
            fs.rm(whole, { recursive: true, force: true }, null)
        }
        try {
            fs.mkdirSync(parent, { recursive: true })
        }
        catch (e) { }

        const stream = fs.createWriteStream(whole, context.stats)

        tunnel.pipe(stream)
        tunnel.on("end", () => {
            tunnel.end()
            stream.end()
        })
        stream.on("finish", () => {
            tunnel.end()
            console.log("sync finished", whole)

            fs.utimesSync(whole, context.stats.atime, context.stats.mtime)

            this.files[context.relative] = fs.statSync(whole)
        })
        console.log("sync", whole)
    }
}