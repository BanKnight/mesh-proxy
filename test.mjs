import { Duplex } from "stream"

const app = {
    write(id, chunk)
    {
        console.log(id, chunk.toString("utf8"))
    }
}

const duplex = new Duplex()

duplex.id = 1
duplex._write = function (chunk, encoding, callback)
{
    app.write(this.id, chunk);
    callback();
}

duplex._read = function ()
{

}
process.stdin.on("data", (chunk) =>
{
    duplex.push(chunk)
    // console.log("stdin get", chunk)
})

setTimeout(() =>
{
    duplex.on("data", (data) =>
    {
        duplex.write(data)
    })
}, 3000)

