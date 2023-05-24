import { spawn } from "child_process";
import { createInterface } from "readline"

import { Component, ComponentOption, ConnectListener, ConnectionContext, Tunnel } from "../types.js";

export default class Shell extends Component {

    constructor(options: ComponentOption) {
        super(options)

        this.on("ready", this.ready.bind(this))
        this.on("close", this.close.bind(this))
        this.on("connection", this.connection.bind(this))
    }

    ready() {

        if (this.options.command == null) {
            return
        }

        const child = spawn(this.options.command, this.options.args, {
            ...this.options.options,
        })

        // child.stderr.pipe(process.stderr)
        // child.stdout.pipe(process.stdout)

    }
    close() { }

    connection(tunnel: Tunnel, context: ConnectionContext, callback: ConnectListener) {

        // const readObj = createInterface({
        //     input: tunnel
        // })

        // // 一行一行地读取文件
        // readObj.on('line', function (line) {
        // })

        // // 读取完成后,将arr作为参数传给回调函数
        // readObj.on('close', function () { })

    }
}